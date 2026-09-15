"""Structured outputs exchanged between agents. Validation is lenient on shape, strict on meaning."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


def _ids(value: object) -> list[str]:
    if isinstance(value, str):
        value = value.replace("[", " ").replace("]", " ").replace(",", " ").split()
    return [str(v).strip().upper() for v in (value or []) if str(v).strip()]


class SubQuestion(_Model):
    id: str
    question: str
    rationale: str = ""


class Plan(_Model):
    tier: Literal["light", "full"] = "full"
    subquestions: list[SubQuestion] = Field(min_length=1, max_length=6)
    success_criteria: list[str] = Field(default_factory=list)


class Finding(_Model):
    statement: str
    evidence_ids: list[str] = Field(default_factory=list)

    @field_validator("evidence_ids", mode="before")
    @classmethod
    def _norm_ids(cls, value: object) -> list[str]:
        return _ids(value)


class ResearchNote(_Model):
    findings: list[Finding] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)
    tensions: list[str] = Field(default_factory=list)


class Locus(_Model):
    id: str
    question: str
    rationale: str = ""


class LociPlan(_Model):
    loci: list[Locus] = Field(default_factory=list, max_length=4)


class DepthNote(_Model):
    position: str
    reasoning: str = ""
    evidence_ids: list[str] = Field(default_factory=list)
    confidence: Literal["low", "medium", "high"] = "medium"
    would_change_mind: str = ""

    @field_validator("evidence_ids", mode="before")
    @classmethod
    def _norm_ids(cls, value: object) -> list[str]:
        return _ids(value)


class CriticFinding(_Model):
    severity: Literal["critical", "major", "minor"] = "major"
    anchor: str = Field(description="Exact text copied from the draft that the finding is about.")
    issue: str
    suggestion: str = ""


class CriticReport(_Model):
    findings: list[CriticFinding] = Field(default_factory=list, max_length=8)


class Edit(_Model):
    find: str = Field(description="Exact text currently in the report; must occur exactly once.")
    replace: str
    reason: str = ""


class PatchSet(_Model):
    edits: list[Edit] = Field(default_factory=list)


class Verdict(_Model):
    pair_id: str
    verdict: Literal["supported", "partial", "unsupported"]
    note: str = ""

    @field_validator("pair_id", mode="before")
    @classmethod
    def _str(cls, value: object) -> str:
        return str(value).strip()


class VerdictSet(_Model):
    verdicts: list[Verdict] = Field(default_factory=list)
