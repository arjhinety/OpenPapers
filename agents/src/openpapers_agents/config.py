"""Runtime settings. Everything provider-specific comes from environment variables.

Any OpenAI-compatible endpoint works (OpenAI, Gemini, Anthropic, OpenRouter, Ollama, vLLM,
Cline, ...): set OPA_BASE_URL + OPA_MODEL + a key. Without OPA_BASE_URL, OPA_MODEL is treated as a
native LangChain id ("anthropic:claude-...", "google_genai:gemini-...") and requires `langchain`
plus the provider package.
"""

from __future__ import annotations

import os
import shlex
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

PACKAGE_ROOT = Path(__file__).resolve().parents[2]  # agents/
REPO_ROOT = PACKAGE_ROOT.parent  # OpenPapers/

ROLES = ("planner", "researcher", "analyst", "writer", "critic", "patcher", "verifier")


@dataclass(frozen=True)
class LLMSettings:
    model: str
    base_url: str | None
    api_key: str | None
    reasoning: bool
    timeout: float
    max_retries: int


@dataclass(frozen=True)
class Settings:
    llm: LLMSettings
    role_models: dict[str, str] = field(default_factory=dict)
    llm_concurrency: int = 4
    mcp_concurrency: int = 2
    server_command: tuple[str, ...] = ()
    runs_dir: Path = PACKAGE_ROOT / "runs"

    def model_for(self, role: str) -> str:
        return self.role_models.get(role, self.llm.model)


def _flag(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def load_settings(env_file: Path | None = None) -> Settings:
    for candidate in (env_file, PACKAGE_ROOT / ".env", REPO_ROOT / ".env"):
        if candidate and candidate.exists():
            load_dotenv(candidate, override=False)

    model = os.getenv("OPA_MODEL")
    if not model:
        raise RuntimeError(
            "OPA_MODEL is not set. Example (OpenAI-compatible): OPA_BASE_URL=https://api.openai.com/v1 "
            "OPA_MODEL=gpt-5.4-mini OPA_API_KEY_ENV=OPENAI_API_KEY"
        )
    key_env = os.getenv("OPA_API_KEY_ENV")
    api_key = os.getenv("OPA_API_KEY") or (os.getenv(key_env) if key_env else None)
    base_url = os.getenv("OPA_BASE_URL") or None
    if base_url and not api_key:
        raise RuntimeError("OPA_BASE_URL is set but no key found: set OPA_API_KEY or OPA_API_KEY_ENV.")

    role_models = {
        role: os.environ[f"OPA_MODEL_{role.upper()}"]
        for role in ROLES
        if os.getenv(f"OPA_MODEL_{role.upper()}")
    }
    command = os.getenv("OPA_MCP_COMMAND")
    server_command = (
        tuple(shlex.split(command, posix=os.name != "nt"))
        if command
        else ("node", str(REPO_ROOT / "dist" / "mcp" / "server.js"))
    )
    return Settings(
        llm=LLMSettings(
            model=model,
            base_url=base_url,
            api_key=api_key,
            reasoning=_flag(os.getenv("OPA_REASONING")),
            timeout=float(os.getenv("OPA_TIMEOUT", "300")),
            max_retries=int(os.getenv("OPA_MAX_RETRIES", "4")),
        ),
        role_models=role_models,
        llm_concurrency=int(os.getenv("OPA_LLM_CONCURRENCY", "4")),
        mcp_concurrency=int(os.getenv("OPA_MCP_CONCURRENCY", "2")),
        server_command=server_command,
        runs_dir=Path(os.getenv("OPA_RUNS_DIR", str(PACKAGE_ROOT / "runs"))),
    )
