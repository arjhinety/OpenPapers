"""Source text store and evidence ledger.

Quote integrity is enforced when evidence is recorded, not only at the end: a quote is accepted
only if it occurs verbatim (modulo whitespace, quote style and case) in text an OpenPapers tool
actually returned for that source during this run.
"""

from __future__ import annotations

import json
import re
import threading
import unicodedata
from collections import defaultdict
from dataclasses import asdict, dataclass

MIN_QUOTE_CHARS = 15
MAX_QUOTE_CHARS = 700

_TRANSLATE = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", " ": " "})


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).translate(_TRANSLATE)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cf")  # zero-width, math invisibles
    return re.sub(r"\s+", " ", text).strip().casefold()


# Math markup and editorial [insertions] split a quote into prose fragments. Papers rendered from
# HTML carry each formula twice (Unicode + LaTeX alttext), so writers legitimately reformat math.
# Only grammatical completions may be bracketed in: "[not]" or an ellipsis could invert a meaning.
_GRAMMAR_INSERT = r"\[(?:s|es|ed|d|a|an|the|that|which|it|its|they|their|this|these|is|are|was|were)\]"
_SPLIT_RE = re.compile(r"\\\(.*?\\\)|\\\[.*?\\\]|\$[^$]*\$|\\[a-zA-Z]+(?:\{[^{}]*\})*|[_^{}\\]|" + _GRAMMAR_INSERT, re.IGNORECASE)
MIN_FRAGMENT_WORDS = 3
MIN_FRAGMENT_COVERAGE = 0.6  # share of the quote's ASCII letters/digits that must sit in verbatim fragments


def _alnum(text: str) -> int:
    return len(re.sub(r"[^a-z0-9]", "", text))


def quote_in(quote: str, haystack: str) -> bool:
    """Verbatim match, allowing only math reformatting and grammatical [insertions] between
    verbatim prose fragments of 3+ words that together cover most of the quote."""
    needle = normalize(quote).strip(" .,;:")
    if not needle:
        return False
    if needle in haystack:
        return True
    if not _SPLIT_RE.search(quote):
        return False
    fragments = [normalize(f).strip(" .,;:()") for f in _SPLIT_RE.split(quote)]
    fragments = [f for f in fragments if len(f.split()) >= MIN_FRAGMENT_WORDS]
    # both sides counted in the same unit: ASCII alphanumerics, LaTeX command names excluded
    total = _alnum(re.sub(r"\\[a-z]+", "", needle))
    if not fragments or sum(_alnum(f) for f in fragments) < MIN_FRAGMENT_COVERAGE * total:
        return False
    return all(f in haystack for f in fragments)


def source_key(url: str) -> str:
    """Canonical key for a source URL: no fragment, query, trailing slash or arXiv version."""
    key = url.split("#", 1)[0].split("?", 1)[0].rstrip("/").lower()
    key = re.sub(r"^https?://(www\.)?", "", key)
    return re.sub(r"(arxiv\.org/(?:abs|html|pdf)/\d{4}\.\d{4,5})v\d+", r"\1", key)


class SourceStore:
    """Every text span a tool returned, grouped by source."""

    def __init__(self) -> None:
        self._texts: dict[str, list[str]] = defaultdict(list)
        self._normalized: dict[str, str] = {}
        self.titles: dict[str, str] = {}
        self.urls: dict[str, str] = {}
        self._lock = threading.Lock()

    def add(self, url: str, text: str, title: str | None = None) -> None:
        if not url or not text:
            return
        key = source_key(url)
        with self._lock:
            self._texts[key].append(text)
            self._normalized.pop(key, None)
            self.urls.setdefault(key, url.split("#", 1)[0])
            if title and key not in self.titles:
                self.titles[key] = title

    def _haystack(self, key: str) -> str:
        if key not in self._normalized:
            self._normalized[key] = normalize("\n".join(self._texts.get(key, [])))
        return self._normalized[key]

    def contains(self, url: str, quote: str) -> bool:
        return quote_in(quote, self._haystack(source_key(url)))

    def locate(self, quote: str) -> str | None:
        """Return the key of any source containing `quote` (used by the report-level gate)."""
        return next((key for key in list(self._texts) if quote_in(quote, self._haystack(key))), None)

    def title_for(self, url: str) -> str:
        return self.titles.get(source_key(url), "")

    def known(self, url: str) -> bool:
        return source_key(url) in self._texts

    @property
    def source_count(self) -> int:
        return len(self._texts)


@dataclass
class Evidence:
    id: str
    source_url: str
    title: str
    locator: str
    quote: str
    claim: str
    recorded_by: str

    def brief(self, quote_chars: int = 400) -> str:
        quote = self.quote if len(self.quote) <= quote_chars else self.quote[:quote_chars] + "..."
        return f"[{self.id}] {self.title or self.source_url} ({self.locator or 'n/a'}): \"{quote}\" | claim: {self.claim}"


class Ledger:
    def __init__(self, store: SourceStore) -> None:
        self.store = store
        self.items: dict[str, Evidence] = {}
        self.rejections: list[dict[str, str]] = []
        self._lock = threading.Lock()

    def record(self, source_url: str, quote: str, claim: str, locator: str, agent: str) -> Evidence | str:
        """Add evidence or return a rejection message the agent can act on."""
        quote = quote.strip().strip('"').strip("“”").strip()
        reason = self._check(source_url, quote)
        if reason:
            with self._lock:
                self.rejections.append({"agent": agent, "source_url": source_url, "quote": quote[:300], "reason": reason})
            return reason
        with self._lock:
            for existing in self.items.values():
                if source_key(existing.source_url) == source_key(source_url) and normalize(existing.quote) == normalize(quote):
                    return existing
            evidence = Evidence(
                id=f"E{len(self.items) + 1}",
                source_url=source_url.split("#", 1)[0],
                title=self.store.title_for(source_url),
                locator=locator.strip()[:200],
                quote=quote,
                claim=claim.strip()[:500],
                recorded_by=agent,
            )
            self.items[evidence.id] = evidence
            return evidence

    def _check(self, source_url: str, quote: str) -> str | None:
        if not self.store.known(source_url):
            return "REJECTED_UNKNOWN_SOURCE: read or search this source with a tool first; use the exact URL the tool reported."
        length = len(normalize(quote))
        if length < MIN_QUOTE_CHARS:
            return f"REJECTED_QUOTE_TOO_SHORT: quote at least {MIN_QUOTE_CHARS} characters of the source text."
        if length > MAX_QUOTE_CHARS:
            return f"REJECTED_QUOTE_TOO_LONG: keep the quote under {MAX_QUOTE_CHARS} characters; quote only the supporting span."
        if not self.store.contains(source_url, quote):
            return "REJECTED_QUOTE_NOT_FOUND: the quote must be copied verbatim from text a tool returned for this source. Do not paraphrase inside the quote."
        return None

    def get(self, evidence_id: str) -> Evidence | None:
        return self.items.get(evidence_id.strip().upper())

    def briefs(self, ids: list[str] | None = None, quote_chars: int = 400) -> str:
        chosen = [self.items[i] for i in ids if i in self.items] if ids is not None else list(self.items.values())
        return "\n".join(item.brief(quote_chars) for item in chosen) or "(no evidence recorded)"

    def to_jsonl(self) -> str:
        return "\n".join(json.dumps(asdict(item), ensure_ascii=False) for item in self.items.values())
