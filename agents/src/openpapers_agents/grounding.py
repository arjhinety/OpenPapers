"""Independent grounding checks for cited sentences.

The LLM verifier is the same kind of model that wrote the report. Small, CPU-friendly
hallucination/NLI models give an independent vote on each (cited quotes, sentence) pair:

  lettucedetect  KRLabsOrg LettuceDetect (ModernBERT token classifier, MIT)
  minicheck      Liyan06 MiniCheck (RoBERTa/DeBERTa/Flan-T5 fact checker)

Every score is P(sentence supported by the cited quotes), in [0, 1]. Install with
`uv sync --extra grounding`; select with OPA_GROUNDING=auto|off|lettucedetect,minicheck.

Memory: models are loaded only inside the citation check, one at a time, and released right after
scoring, so no checker sits in RAM during the research phase. `auto` uses LettuceDetect alone
(~0.6 GB); adding MiniCheck costs ~1.5 GB more while it scores.
"""

from __future__ import annotations

import gc
import importlib.util
import inspect
import os
import re
from dataclasses import dataclass
from typing import Callable, Protocol

DEFAULT_LETTUCE_MODEL = "KRLabsOrg/lettucedect-base-modernbert-en-v1"
DEFAULT_MINICHECK_MODEL = "roberta-large"
# Calibrated for LettuceDetect on 127 blind-labelled pairs (evals/grounding): chosen on the QLoRA split,
# held-out DPO balanced accuracy 0.848 -> 0.866 vs 0.5. MiniCheck is not calibrated; set it explicitly.
DEFAULT_THRESHOLD = 0.45


class GroundingChecker(Protocol):
    name: str

    def support(self, pairs: list[tuple[str, str]], question: str) -> list[float]:
        """(context, claim) pairs -> probability each claim is supported by its context."""
        ...


class LettuceDetectChecker:
    """Span-level detector: support = 1 - confidence of the most confident hallucinated span.

    Not a character share: a wrong two-character number ("48" for "780") is a tiny fraction of a
    sentence but is exactly the error a citation check must catch (smoke test: share scoring gave
    0.98 for that sentence, max-span scoring rejects it)."""

    name = "lettucedetect"

    def __init__(self, model_path: str = DEFAULT_LETTUCE_MODEL) -> None:
        from lettucedetect.models.inference import HallucinationDetector

        self._detector = HallucinationDetector(method="transformer", model_path=model_path)

    def support(self, pairs: list[tuple[str, str]], question: str, prefixes: list[str] | None = None) -> list[float]:
        """`prefixes[i]` (the previous report sentence) is prepended to an anaphoric claim so "This…"
        can be resolved; only spans inside the claim itself count, so the prefix can neither add
        support nor be penalised."""
        scores = []
        for n, (context, claim) in enumerate(pairs):
            prefix = (prefixes[n] if prefixes else "") or ""
            answer = f"{prefix} {claim}" if prefix else claim
            offset = len(prefix) + 1 if prefix else 0
            spans = self._detector.predict(context=[context], question=question, answer=answer, output_format="spans")
            worst = max((float(s.get("confidence", 1.0)) for s in spans if int(s.get("end", 0)) > offset), default=0.0)
            scores.append(round(1.0 - worst, 4))
        return scores


class MiniCheckChecker:
    name = "minicheck"

    def __init__(self, model_name: str = DEFAULT_MINICHECK_MODEL, cache_dir: str | None = None) -> None:
        from minicheck.minicheck import MiniCheck

        self._scorer = MiniCheck(model_name=model_name, cache_dir=cache_dir or os.path.expanduser("~/.cache/minicheck"))

    def support(self, pairs: list[tuple[str, str]], question: str) -> list[float]:
        if not pairs:
            return []
        _, raw_prob, _, _ = self._scorer.score(docs=[c for c, _ in pairs], claims=[claim for _, claim in pairs])
        return [round(float(p), 4) for p in raw_prob]


_BUILDERS = {
    "lettucedetect": lambda: LettuceDetectChecker(os.getenv("OPA_LETTUCE_MODEL", DEFAULT_LETTUCE_MODEL)),
    "minicheck": lambda: MiniCheckChecker(os.getenv("OPA_MINICHECK_MODEL", DEFAULT_MINICHECK_MODEL)),
}


# arXiv HTML renders math twice ("π ref \pi_{\text{ref}}") while writers use LaTeX only, so context and
# claim are normalized the same way: Greek letters (Unicode or LaTeX) become words, other markup is
# dropped, doubled words collapse. A consistency measure, not a proven accuracy gain.
_GREEK = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau phi chi psi omega".split()
_UNICODE_GREEK = dict(zip("αβγδεζηθικλμνξπρστφχψω", _GREEK))
_LATEX_CMD = re.compile(r"\\([a-zA-Z]+)")
_LATEX_REST = re.compile(r"\\[()\[\]]|[{}_^$\\]")


def plain(text: str) -> str:
    """Text as an NLI model should see it: math markup reduced to words, whitespace collapsed."""
    text = "".join(f" {_UNICODE_GREEK[ch]} " if ch in _UNICODE_GREEK else ch for ch in text)
    text = _LATEX_CMD.sub(lambda m: f" {m.group(1)} " if m.group(1) in _GREEK else " ", text)
    text = re.sub(r"\s+", " ", _LATEX_REST.sub(" ", text)).strip()
    text = re.sub(r"\b(\w+(?: \w+)?)(?: \1\b)+", r"\1", text)  # "pi ref pi ref" -> "pi ref"
    return re.sub(r"\s+([,.;:])", r"\1", text)


_ANAPHOR_RE = re.compile(r"^\W*(this|these|that|those|it|its|they|their|such|both|thus|hence|therefore)\b", re.IGNORECASE)


def is_anaphoric(sentence: str) -> bool:
    """Opens by pointing back ("This keeps...", "They spill..."), so it needs the previous sentence."""
    return bool(_ANAPHOR_RE.match(sentence))


def is_meta(section: str) -> bool:
    """Sentences about gaps in the evidence cannot be supported by quotes; don't score them."""
    return bool(re.search(r"limitation|open question|future work", section, re.IGNORECASE))


_MODULES = {"lettucedetect": "lettucedetect", "minicheck": "minicheck"}
AUTO = ("lettucedetect",)  # lightest useful default; MiniCheck is opt-in


def resolve_checkers(spec: str | None = None) -> tuple[list[str], list[str]]:
    """Checker names to use, without loading any model. Problems are reported, never raised,
    because grounding is an extra vote, not a requirement."""
    spec = (spec if spec is not None else os.getenv("OPA_GROUNDING", "auto")).strip().lower()
    if spec in {"", "off", "none", "0"}:
        return [], []
    wanted = list(AUTO) if spec == "auto" else [n.strip() for n in spec.split(",") if n.strip()]
    names: list[str] = []
    problems: list[str] = []
    for name in wanted:
        if name not in _BUILDERS:
            problems.append(f"{name}: unknown checker")
        elif importlib.util.find_spec(_MODULES[name]) is None:
            if spec != "auto":
                problems.append(f"{name}: not installed (uv sync --extra grounding)")
        else:
            names.append(name)
    return names, problems


def score_pairs(
    checkers: "list[str | GroundingChecker]",
    pairs: list[tuple[str, str]],
    question: str,
    on_error: Callable[[str, Exception], None] | None = None,
    prefixes: list[str] | None = None,
) -> dict[str, list[float]]:
    """Score with each checker in turn. Names are built, used and released one at a time so at
    most one model is resident; ready-made checker objects (tests) are used as-is. `prefixes` go
    only to checkers whose `support` accepts them (span-level ones)."""
    results: dict[str, list[float]] = {}
    for item in checkers:
        name = item if isinstance(item, str) else item.name
        checker = None
        try:
            checker = _BUILDERS[item]() if isinstance(item, str) else item
            takes_prefixes = "prefixes" in inspect.signature(checker.support).parameters
            results[name] = checker.support(pairs, question, prefixes) if takes_prefixes else checker.support(pairs, question)
        except Exception as exc:  # noqa: BLE001 - a broken checker only loses its vote
            if on_error:
                on_error(name, exc)
        finally:
            if isinstance(item, str):
                del checker
                gc.collect()
    return results


@dataclass
class Vote:
    scores: dict[str, float]
    supported_votes: int
    total: int

    @property
    def all_reject(self) -> bool:
        return self.total > 0 and self.supported_votes == 0


def vote(scores: dict[str, float], threshold: float = DEFAULT_THRESHOLD) -> Vote:
    return Vote(scores=scores, supported_votes=sum(1 for s in scores.values() if s >= threshold), total=len(scores))


def reconcile(llm_verdict: str, grounding: Vote) -> tuple[str, str | None]:
    """Combine the LLM verdict with the independent vote.

    Only one direction changes a verdict: an LLM "supported" that every independent checker
    rejects becomes "partial" and goes to repair. Checkers never upgrade a verdict, so a weak
    NLI model can cost a repair round but can never wave an unsupported sentence through.
    """
    if llm_verdict == "supported" and grounding.all_reject:
        detail = ", ".join(f"{k}={v:.2f}" for k, v in grounding.scores.items())
        return "partial", f"independent grounding checkers reject this sentence ({detail})"
    return llm_verdict, None
