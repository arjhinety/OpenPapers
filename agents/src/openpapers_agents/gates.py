"""Mechanical report checks. None of these ask a model; they are the ship gate's hard floor."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .evidence import Ledger, SourceStore, normalize
from .schemas import Edit

CITE_RE = re.compile(r"\[(E\d+(?:\s*[,;]\s*E\d+)*)\]", re.IGNORECASE)
MIN_QUOTE_SPAN = 20  # shorter quoted spans ("reward", scare quotes) are terminology, not citations
NUMBER_RE = re.compile(r"(?<![\w.])(\d+(?:[.,]\d+)?)(\s?%)?")
MAX_FIND_CHARS = 1500  # an edit may touch a passage, never the whole report


@dataclass
class PatchResult:
    text: str
    applied: list[dict] = field(default_factory=list)
    rejected: list[dict] = field(default_factory=list)


def apply_edits(text: str, edits: list[Edit], known_ids: set[str]) -> PatchResult:
    """Apply find/replace edits surgically: each `find` must occur exactly once, be bounded in
    size, and the replacement may only cite evidence that exists."""
    result = PatchResult(text=text)
    for edit in edits:
        entry = edit.model_dump()
        count = result.text.count(edit.find) if edit.find else 0
        new_ids = {i.upper() for i in cited_ids(edit.replace)}
        if not edit.find.strip():
            reason = "empty find"
        elif len(edit.find) > MAX_FIND_CHARS:
            reason = f"find longer than {MAX_FIND_CHARS} chars (regeneration is not allowed)"
        elif count != 1:
            reason = f"find occurs {count} times (must be exactly 1)"
        elif not new_ids <= known_ids:
            reason = f"replacement cites unknown evidence {sorted(new_ids - known_ids)}"
        else:
            result.text = result.text.replace(edit.find, edit.replace, 1)
            result.applied.append(entry)
            continue
        result.rejected.append({**entry, "rejection": reason})
    return result


def cited_ids(text: str) -> list[str]:
    ids: list[str] = []
    for group in CITE_RE.findall(text):
        ids += [part.strip().upper() for part in re.split(r"[,;]", group)]
    return ids


def body_of(report: str) -> str:
    """Report text minus the generated References section."""
    return re.split(r"\n#+\s*References\b", report, maxsplit=1, flags=re.IGNORECASE)[0]


def sentences(report: str) -> list[str]:
    out: list[str] = []
    for line in body_of(report).splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", "|", "```", "---")):
            continue
        stripped = re.sub(r"^([-*+]|\d+\.)\s+", "", stripped)
        for piece in re.split(r"(?<=[.!?])\s+(?=[A-Z\[(\"“])", stripped):
            if piece.strip():
                out.append(piece.strip())
    # a citation that starts the next piece belongs to the previous sentence
    merged: list[str] = []
    for piece in out:
        if merged and CITE_RE.match(piece):
            match = CITE_RE.match(piece)
            merged[-1] += " " + match.group(0)
            piece = piece[match.end():].lstrip(" .")
            if not piece:
                continue
        merged.append(piece)
    return merged


def _trivial_number(number: str) -> bool:
    """Single digits and publication years are structure, not quantitative claims."""
    if re.fullmatch(r"\d", number):
        return True
    return bool(re.fullmatch(r"(19|20)\d\d", number))


@dataclass
class GateReport:
    cited_sentences: int
    uncited_sentences: int
    unknown_ids: list[str]
    quote_violations: list[str]
    untraceable_numbers: list[dict]
    distinct_evidence_cited: int
    distinct_sources_cited: int

    @property
    def hard_failures(self) -> int:
        return len(self.unknown_ids) + len(self.quote_violations)

    def as_dict(self) -> dict:
        return {**self.__dict__, "hard_failures": self.hard_failures}


def check_report(report: str, ledger: Ledger, store: SourceStore) -> GateReport:
    body = body_of(report)
    cited, uncited = 0, 0
    untraceable: list[dict] = []
    all_ids: list[str] = []
    for sentence in sentences(body):
        ids = cited_ids(sentence)
        if not ids:
            if len(sentence.split()) >= 8 and not sentence.endswith(":"):
                uncited += 1
            continue
        cited += 1
        all_ids += ids
        support = normalize(" ".join(ledger.items[i].quote for i in ids if i in ledger.items))
        claim_text = CITE_RE.sub("", sentence)
        for number, _pct in NUMBER_RE.findall(claim_text):
            if _trivial_number(number):
                continue
            if normalize(number) not in support and normalize(number.replace(",", "")) not in support:
                untraceable.append({"sentence": sentence[:300], "number": number})
    unknown = sorted({i for i in all_ids if i not in ledger.items})
    violations = [inner for _, _, inner in quotes(body) if store.locate(inner) is None]
    known = {i for i in all_ids if i in ledger.items}
    return GateReport(
        cited_sentences=cited,
        uncited_sentences=uncited,
        unknown_ids=unknown,
        quote_violations=violations,
        untraceable_numbers=untraceable,
        distinct_evidence_cited=len(known),
        distinct_sources_cited=len({ledger.items[i].source_url for i in known}),
    )


def dedupe_repeats(report: str) -> tuple[str, int]:
    """Drop a sentence when the next one on the same line repeats it verbatim as its prefix
    (the patcher's "neighbour + new sentence" insertions can echo the anchor)."""
    removed = 0
    lines = []
    for line in report.splitlines():
        pieces = re.split(r"(?<=[.!?])\s+", line)
        kept: list[str] = []
        for piece in pieces:
            marker = re.match(r"^\s*(?:[-*+]|\d+\.)\s+", kept[-1]) if kept else None
            prefix = marker.group(0) if marker else ""
            core = kept[-1][len(prefix):].rstrip(" .") if kept else ""
            if len(core) > 20 and piece.startswith(core):
                kept[-1] = prefix + piece
                removed += 1
            else:
                kept.append(piece)
        lines.append(" ".join(kept))
    return "\n".join(lines) + ("\n" if report.endswith("\n") else ""), removed


def quoted_spans(text: str) -> list[tuple[int, int]]:
    """(open, close) indices of quotation marks, paired in order per paragraph.

    A regex over straight quotes mis-pairs as soon as a short quote is skipped: the closing mark of
    `"reward"` becomes the opening of a phantom quote spanning the next sentences. Pairing marks
    sequentially (curly quotes by direction) avoids that; an unpaired final mark is ignored."""
    spans: list[tuple[int, int]] = []
    offset = 0
    for paragraph in re.split(r"(\n\s*\n)", text):
        straight_open: int | None = None
        curly_open: int | None = None
        for i, ch in enumerate(paragraph):
            if ch == '"':
                if straight_open is None:
                    straight_open = i
                else:
                    spans.append((offset + straight_open, offset + i))
                    straight_open = None
            elif ch == "“":
                curly_open = i
            elif ch == "”" and curly_open is not None:
                spans.append((offset + curly_open, offset + i))
                curly_open = None
        offset += len(paragraph)
    return sorted(spans)


def quotes(text: str) -> list[tuple[int, int, str]]:
    """Quoted spans long enough to be citations: (open, close, inner text)."""
    return [(a, b, text[a + 1 : b]) for a, b in quoted_spans(text) if len(text[a + 1 : b].strip()) >= MIN_QUOTE_SPAN]


def unquote_unverified(report: str, store: SourceStore) -> tuple[str, list[str]]:
    """Last resort for quoted spans no source contains: drop the quotation marks so the text reads
    as paraphrase instead of falsely claiming to be verbatim."""
    body, tail = body_of(report), report[len(body_of(report)):]
    fixed: list[str] = []
    drop: set[int] = set()
    for a, b, inner in quotes(body):
        if store.locate(inner) is None:
            fixed.append(inner)
            drop.update((a, b))
    return "".join(ch for i, ch in enumerate(body) if i not in drop) + tail, fixed


def section_of_sentences(report: str) -> dict[str, str]:
    """sentence -> the markdown heading it sits under."""
    heading = ""
    out: dict[str, str] = {}
    for line in body_of(report).splitlines():
        if line.lstrip().startswith("#"):
            heading = line.strip("# ").strip()
            continue
        for sentence in sentences(line):
            out.setdefault(sentence, heading)
    return out


def cited_pairs(report: str) -> list[tuple[str, list[str]]]:
    return [(s, ids) for s in sentences(report) if (ids := cited_ids(s))]


def render_references(report: str, ledger: Ledger) -> str:
    order: list[str] = []
    for evidence_id in cited_ids(body_of(report)):
        if evidence_id in ledger.items and evidence_id not in order:
            order.append(evidence_id)
    lines = ["## References", ""]
    for evidence_id in order:
        item = ledger.items[evidence_id]
        quote = item.quote if len(item.quote) <= 300 else item.quote[:300] + "..."
        where = f" ({item.locator})" if item.locator else ""
        lines.append(f"- **[{evidence_id}]** {item.title or item.source_url}{where}. <{item.source_url}> — “{quote}”")
    return body_of(report).rstrip() + "\n\n" + "\n".join(lines) + "\n"
