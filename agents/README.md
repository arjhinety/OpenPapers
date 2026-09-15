# OpenPapers Agents

Multi-agent literature research on top of the OpenPapers MCP server. A LangGraph pipeline of
specialised agents plans, researches, investigates, drafts, critiques, patches and citation-checks a
report. **Every cited quote is machine-verified against source text the tools actually returned**,
and every run produces a [graphify](https://github.com/Graphify-Labs/graphify) knowledge graph of
what was retrieved.

Provider-agnostic: any OpenAI-compatible endpoint (OpenAI, Gemini, Anthropic, OpenRouter, Ollama,
vLLM, the Cline gateway) or any native LangChain chat model. Nothing is tied to one vendor or one
agent harness.

- [Bootstrap](#bootstrap) — from a fresh machine to a first report
- [Pipeline](#pipeline) · [Guarantees](#guarantees-enforced-in-code-not-prompts) · [Knowledge graph](#knowledge-graph-graphify)
- [Evaluation](#evaluation) · [Configuration reference](#configuration-reference) · [Troubleshooting](#troubleshooting)

---

## Bootstrap

### 1. Prerequisites

| Tool | Version | Check | Install |
|---|---|---|---|
| Git | any | `git --version` | <https://git-scm.com> |
| Node.js + npm | **22.5+** (runs the OpenPapers MCP server) | `node --version` | <https://nodejs.org> |
| Python | **3.12+** | `python --version` | <https://python.org> (uv can also install it) |
| uv | 0.5+ | `uv --version` | `pip install uv` or <https://docs.astral.sh/uv/> |
| LLM API key | a model that supports **tool/function calling** | — | any provider below |

No GPU, Docker or database is needed. Scholarly search uses public APIs (arXiv, Crossref, OpenAlex,
Semantic Scholar); an internet connection is required.

### 2. Build the OpenPapers MCP server

The agents drive OpenPapers over MCP stdio, so the server must be built first.

```bash
git clone https://github.com/arjhinety/OpenPapers.git
cd OpenPapers
npm ci
npm run build                  # produces dist/mcp/server.js
```

Optional sanity check — the server should print `OpenPapers stdio server running` (Ctrl+C to stop):

```bash
node dist/mcp/server.js
```

### 3. Install the agents package

```bash
cd agents
uv sync                        # creates .venv with LangGraph, langchain-mcp-adapters, graphify, ...
```

Two optional extras (install both with `uv sync --extra grounding --extra tracing`):

| Extra | Adds | Cost |
|---|---|---|
| `grounding` | Independent citation checkers (LettuceDetect + MiniCheck) that vote alongside the LLM verifier | ~1.1 GB of packages (CPU PyTorch) plus ~3.3 GB of model weights downloaded on first run (LettuceDetect 0.6 GB, MiniCheck 2.7 GB); no GPU needed |
| `tracing` | Langfuse SDK for per-node / per-LLM-call traces | small; needs Langfuse keys to activate |

### 4. Choose an LLM provider

```bash
cp .env.example .env
```

Edit `agents/.env` and set three things: the endpoint, the model, and where the key lives.
Keep the key itself out of this file by pointing `OPA_API_KEY_ENV` at an environment variable.

| Provider | `OPA_BASE_URL` | `OPA_MODEL` (example) | `OPA_API_KEY_ENV` |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-5.4-mini` | `OPENAI_API_KEY` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3-flash-preview` | `GEMINI_API_KEY` |
| Anthropic | `https://api.anthropic.com/v1` | `claude-sonnet-5` | `ANTHROPIC_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/v1` | `deepseek/deepseek-v4.1-flash` | `OPENROUTER_API_KEY` |
| Cline gateway | `https://api.cline.bot/api/v1` | `cline-pass/deepseek-v4.1-flash` | `CLINE_API_KEY` |
| Ollama (local) | `http://localhost:11434/v1` | `qwen3.5:9b` | `OLLAMA_API_KEY` (any non-empty value) |

Then make the key available, either in your shell:

```bash
export OPENAI_API_KEY=sk-...          # PowerShell: $env:OPENAI_API_KEY = "sk-..."
```

or in the **OpenPapers root** `.env` (`OPENAI_API_KEY=sk-...`), which is git-ignored. Settings are read
from `agents/.env`, then `OpenPapers/.env`; variables already set in your shell always win.

Using a **reasoning model** (DeepSeek, o-series, Qwen thinking)? Set `OPA_REASONING=1`: temperature
is left to the provider and inline `<think>` blocks are stripped before JSON parsing.

Prefer a native SDK over an OpenAI-compatible endpoint? Leave `OPA_BASE_URL` empty and use a
LangChain model id, e.g. `OPA_MODEL=anthropic:claude-sonnet-5` after
`uv pip install langchain langchain-anthropic`.

### 5. Optional: scholarly API credentials

arXiv and Semantic Scholar rate-limit anonymous clients hard (HTTP 429), which makes runs slower.
Add keys to the **OpenPapers root** `.env` to reduce it — the agents pass that file's variables to
the server they start:

```bash
SEMANTIC_SCHOLAR_API_KEY=...            # free key: https://www.semanticscholar.org/product/api
OPENALEX_API_KEY=...                    # free key from your OpenAlex account
GITHUB_TOKEN=...                        # optional: implementation/repository lookups
HF_TOKEN=...                            # optional: model/dataset lookups, grounding model downloads
```

OpenAlex has required an API key since February 2026 (the old `mailto` "polite pool" is gone;
`OPENALEX_EMAIL` is still sent but no longer grants anything). Without a key OpenAlex only allows a
small demo allowance; arXiv, Crossref and Semantic Scholar still cover search.

### 6. Verify the install

```bash
uv run pytest                  # 40 offline tests, no network or API key needed
uv run openpapers-doctor       # live checks: config, MCP handshake, LLM, tool calling, graphify
```

A healthy setup prints:

```
[ ok ] configuration: model=... endpoint=... key=set reasoning=...
[ ok ] OpenPapers MCP handshake: 37 tools in 1.1s
[ ok ] LLM reachable: 4.1s, replied 'OK'
[ ok ] tool calling: 1.2s, called echo({'word': 'papers'})
[ ok ] graphify: knowledge graphs enabled
[ ok ] grounding: independent checkers: lettucedetect (loaded lazily during citation check)
[warn] tracing: Langfuse off (set LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY to enable)

Ready.
```

If the tool-calling check fails, pick a different model — the researcher agents cannot work without it.

### 7. Your first run

Start with the **light** tier (plan → parallel research → write → citation check):

```bash
uv run openpapers-agents "How does Direct Preference Optimization avoid training an explicit reward model, and what does beta control?" --tier light --max-subquestions 2
```

Then a **full** run (adds depth loci, parallel investigators, four critics and the patcher):

```bash
uv run openpapers-agents "How does QLoRA reduce fine-tuning memory compared with LoRA, and does it match full 16-bit fine-tuning quality?" --tier full --max-subquestions 3
```

`--tier auto` (the default) lets the planner choose. The command prints a metrics summary and the
report path, and exits `0` when the report ships, `2` when the ship gate blocks it.

Measured on `cline-pass/deepseek-v4.1-flash` (times are dominated by scholarly-API rate limits and
gateway latency, not compute):

| Tier | Wall time | LLM calls | Reported cost |
|---|---|---|---|
| light, 2 sub-questions | ~9.5 min | 26 | ~$0.04 |
| full, 3 sub-questions + 3 depth loci + 4 critics | ~16.5 min | 72 | ~$0.15 |

Progress is visible while a run is going: `runs/<tag>/events.jsonl` logs every node start/end and
every tool call.

### 8. Read the outputs

Each run writes `runs/<timestamp>-<slug>/`:

| File | Contents |
|---|---|
| `report.md` | Final report with `[E#]` citations and a generated References section |
| `metrics.json` | Evidence accepted/rejected, citation support before/after repair, gate result, edits, LLM calls, tokens, cost |
| `ledger.jsonl` | Every verified evidence quote with source URL and locator |
| `plan.json`, `notes.json`, `loci.json`, `depth_notes.json` | Planner, researcher, analyst and investigator outputs |
| `draft.md`, `critic_findings.json`, `patches.json` | Pre-patch draft, critic findings, applied/rejected edits |
| `cite_check.json` | Per-sentence verifier verdicts before and after repair |
| `evidence_rejections.json` | Quotes the ledger refused, with reasons |
| `events.jsonl` | Timeline of nodes and tool calls |
| `graphify-out/` | `graph.html` (open in a browser), `graph.json`, `GRAPH_REPORT.md` |

---

## Pipeline

```
planner ──► researcher × N (parallel, tool-calling) ──► analyst ──► investigator × K (parallel)
                                                   (light tier skips ─┐)            │
                                                                      ▼             ▼
                    finalize ◄── cite_check + repair ◄── patcher ◄── critic × 4 ◄── writer
                        │
                        └──► graphify knowledge graph
```

| Agent | Job | Output |
|---|---|---|
| planner | Canonical query → 2–5 atomic sub-questions, tier (`light`/`full`), success criteria | `plan.json` |
| researcher ×N | One sub-question each; searches, reads sections, records verbatim evidence | `notes.json` |
| analyst | Picks 1–3 *depth loci*: unresolved tensions, thin load-bearing evidence | `loci.json` |
| investigator ×K | Reads one locus in depth and **commits to a position** with confidence | `depth_notes.json` |
| writer | Report from the evidence ledger only; every factual sentence cites `[E#]` | `draft.md` |
| critic ×4 | Dialectic, depth, width and instruction critics attack the draft in parallel | `critic_findings.json` |
| patcher | Applies findings as **surgical find/replace edits** — it cannot regenerate the report | `patches.json` |
| verifier | Skeptical per-sentence check: do the cited quotes support the sentence? | `cite_check.json` |
| finalize | Mechanical ship gate + references + metrics | `report.md`, `metrics.json` |

Every agent re-reads the verbatim canonical query, so sub-agents stay aligned with what was asked.

## Guarantees enforced in code, not prompts

- **Quote integrity at record time.** `record_evidence` rejects any quote that does not occur
  verbatim in text an OpenPapers tool returned for that URL during the run (whitespace, quote style
  and case are normalized). Paraphrased "quotes" never enter the ledger.
- **Math-aware, not meaning-blind.** arXiv HTML renders each formula twice (Unicode and LaTeX), so a
  quote may reformat math and add grammatical insertions like `[s]` or `[that]` — but every prose
  fragment of 3+ words must still be verbatim and cover ≥60% of the quote. `[not]` and ellipses are
  never accepted.
- **Unknown citations die.** Findings citing ids that don't exist are dropped; report sentences
  citing them are marked unsupported and removed before shipping.
- **Patch, never regenerate.** Each edit's `find` must occur exactly once, is capped at 1,500 chars,
  and its replacement may only cite existing evidence.
- **Numbers must be traceable.** A number in a cited sentence must appear in that sentence's quotes,
  otherwise the sentence is flagged for repair.
- **Repair, then a hard floor.** Flagged sentences get one surgical repair round and are re-verified;
  anything still unsupported is removed, and quoted spans no source contains lose their quotation
  marks rather than shipping as fake verbatim quotes.
- **Ship gate.** `ship: true` only when there are zero unknown citations and zero quoted spans that
  can't be located in a source.
- **Untrusted sources.** Tool output is fenced as `<untrusted-source>` so embedded instructions in
  papers are treated as data.

The design adapts [hyperresearch](https://github.com/jordan-gibbs/hyperresearch)'s width-then-depth
pipeline, adversarial critics, patch-only revision and cite-check gate. The Claude-Code-specific
enforcement there (skills, per-agent tool allowlists) is replaced with code-level checks so any
tool-calling model can run it.

## Independent grounding check

The LLM verifier is the same kind of model that wrote the report, so with the `grounding` extra
two small CPU models vote on every (cited quotes, sentence) pair as well:

| Checker | Model | Score |
|---|---|---|
| `lettucedetect` | [LettuceDetect](https://github.com/KRLabsOrg/LettuceDetect) ModernBERT-base (MIT) | 1 − confidence of the most confident span flagged as hallucinated (a single wrong number fails the sentence) |
| `minicheck` | [MiniCheck](https://github.com/Liyan06/MiniCheck) RoBERTa-large | P(sentence supported by the quotes) |

The rule is deliberately one-directional: when the LLM says *supported* but **every** checker
scores below `OPA_GROUNDING_THRESHOLD` (0.45, calibrated below), the sentence is downgraded to *partial* and goes to
repair. Checkers never upgrade a verdict, so a weak NLI model can cost a repair round but can never
wave an unsupported sentence through. `cite_check.json` keeps both verdicts per sentence
(`llm_verdict`, `grounding`), and `metrics.json → grounding` reports pairs scored, LLM/checker
agreement rate, downgrades and each checker's support rate.

Smoke test on CPU (context: "…requires more than 780 GB of GPU memory"):

| Sentence | LettuceDetect | MiniCheck | Vote |
|---|---|---|---|
| "needs more than 780 GB" (supported) | 1.00 | 0.48 | no veto — one checker supports |
| "needs about 48 GB" (wrong number) | 0.46 | 0.03 | veto → repair |
| "trained on 1,000 TPUs, beats GPT-4" (fabricated) | 0.0004 | 0.004 | veto → repair |

MiniCheck alone would have rejected the correct sentence, which is why a veto needs every checker.

On a live light-tier DPO run (32 cited sentences, LettuceDetect only), the checker agreed with the
LLM verifier on 75% of sentences and sent 6 LLM-"supported" sentences to repair; 5 of the scored
sentences were meta-statements in the Limitations section ("the paper does not report X"), which
quotes cannot support. Those sections are now skipped — re-scoring the same run gives 85.2%
agreement on 27 sentences with 3 vetoes.

### Calibration against labelled data

`evals/grounding/` holds 127 real (sentence, cited quotes) pairs from two grounded runs, labelled
**blind** to every checker score and LLM verdict: *supported* only if every factual claim, numbers
included, follows from the cited quotes (91 supported, 36 not — mostly inferences, rankings,
computed figures, absence claims, and specifics the quotes never mention). The threshold is chosen
on the QLoRA split (93 pairs) and evaluated on the **held-out** DPO split (34 pairs, different paper):

| | Unsupported caught | Supported wrongly flagged |
|---|---|---|
| LLM verifier alone — QLoRA / DPO held-out | 23/31 · 4/5 | 0 · 0 |
| LLM **and** LettuceDetect veto (pipeline rule) — QLoRA / DPO held-out | **29/31 · 5/5** | 8 · 2 |

Across both splits the LLM verifier let 9 unsupported sentences through; the independent veto
caught 7 of them, at the cost of 10 of 91 good sentences (11%) taking an unnecessary repair round
(flagged sentences are rewritten, never deleted). Threshold 0.45 beat the old 0.5 on the held-out
split (balanced accuracy 0.848 → 0.866: two more correct passes, no loss in catching unsupported
ones); inside the veto rule it catches the same 34/36 unsupported sentences as 0.5 while wrongly
flagging 10 good ones instead of 13. Giving anaphoric sentences ("This…") their previous sentence as context showed no measurable
gain (only 6 of 127 pairs are anaphoric), so it is opt-in via `OPA_GROUNDING_CONTEXT=1`.

Caveats: one labeller, two runs, two papers; the numbers show the veto's direction and rough size,
not a benchmark. Re-run with `uv run python evals/grounding/calibrate.py` (needs `--extra grounding`);
`calibration-v1.json` stores every pair's score.
Loading takes ~25 s (LettuceDetect) and ~95 s (MiniCheck) per citation-check pass; scoring runs in
a worker thread alongside the LLM verifier (~0.8 s/pair LettuceDetect, ~3 s/pair MiniCheck on CPU).

Select checkers with `OPA_GROUNDING=auto|off|lettucedetect|minicheck|lettucedetect,minicheck` or skip per
run with `--no-grounding`. `auto` (default) uses LettuceDetect alone; add MiniCheck for a second vote.

**Memory.** No checker is in RAM during research. Models load only inside the citation check, one
at a time, and are released right after scoring: peak extra RAM is ~1 GB with LettuceDetect and
~1.5 GB more while MiniCheck scores. On a machine that is already tight on memory, use
`OPA_GROUNDING=off`.

## Tracing (Langfuse)

With the `tracing` extra and Langfuse keys set, every run becomes one Langfuse trace: each graph
node, LLM call (tokens, latency, cost) and OpenPapers tool call is a nested span, and the run's gate
metrics are attached as trace scores (`supported_rate_after_repair`, `grounding_agreement`,
`hard_gate_failures`, `ship`, `cost_usd_reported`, ...).

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com   # EU; US: https://us.cloud.langfuse.com; or self-hosted URL
```

Langfuse Cloud's free tier needs no local infrastructure; self-hosting Langfuse runs it in Docker.
Without keys, tracing is a silent no-op. `metrics.json → tracing` records the trace id.

## Knowledge graph (graphify)

After every run, the retrieved information becomes a graphify knowledge graph in
`runs/<tag>/graphify-out/`: `graph.html` (interactive — open it in a browser), `graph.json`
(queryable) and `GRAPH_REPORT.md` (communities, god nodes, surprising connections, suggested
questions).

Nodes are the query, sub-questions, depth loci, papers, verified evidence quotes, agent findings and
final report claims. The extraction is built deterministically from run artifacts — no extra LLM
pass — and edge confidence carries the pipeline's verification state:

| Edge | Confidence |
|---|---|
| evidence → paper (`references`) | `EXTRACTED` — quote machine-verified verbatim in the paper |
| report claim → evidence (`cites`) | `EXTRACTED` if the verifier judged it supported, else `INFERRED` |
| finding / depth position → evidence (`cites`) | `INFERRED` — agent assertion |

Paper ids come from the canonical source URL, so the same paper merges across runs. Build one graph
over many runs to see how separate investigations connect, then query it with the graphify CLI
(`uv tool install graphifyy` — the library is already a project dependency, the CLI is optional):

```bash
uv run openpapers-graph runs/*/ --out runs/_graph
graphify query "which papers support the claims about beta?" --graph runs/_graph/graph.json
graphify explain "QLoRA" --graph runs/_graph/graph.json
```

Skip graph building per run with `--no-graph`.

## Evaluation

`evals/run_eval.py` runs a question set sequentially (scholarly APIs rate-limit parallel runs),
aggregates gate and citation metrics, and builds one combined knowledge graph over the batch:

```bash
uv run python evals/run_eval.py evals/questions-v1.json --tier light
```

Results land in `evals/results/eval-<timestamp>.json`: runs shipped, evidence rejection rate,
citation support rate before/after repair, unsupported sentences removed, hard gate failures, LLM
calls, cost and median wall time.

## Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `OPA_BASE_URL` | — | OpenAI-compatible base URL. Empty → `OPA_MODEL` is a native LangChain id |
| `OPA_MODEL` | **required** | Default model for every role |
| `OPA_MODEL_<ROLE>` | — | Per-role override: `PLANNER`, `RESEARCHER`, `ANALYST`, `WRITER`, `CRITIC`, `PATCHER`, `VERIFIER` |
| `OPA_API_KEY` / `OPA_API_KEY_ENV` | — | The key, or the name of the env var holding it |
| `OPA_REASONING` | `0` | `1` for reasoning models |
| `OPA_TIMEOUT`, `OPA_MAX_RETRIES` | `300`, `4` | Per-request timeout (s) and retries for the LLM client |
| `OPA_LLM_CONCURRENCY` | `4` | Parallel LLM calls |
| `OPA_MCP_CONCURRENCY` | `2` | Parallel OpenPapers calls (lower it if you hit 429s) |
| `OPA_MCP_COMMAND` | `node <repo>/dist/mcp/server.js` | Command that starts the MCP server |
| `OPA_MCP_LOG_LEVEL` | `error` | OpenPapers server log level |
| `OPA_RUNS_DIR` | `agents/runs` | Where run folders are written |
| `OPA_GROUNDING` | `auto` | Independent checkers: `auto` (LettuceDetect), `off`, or a comma list of `lettucedetect`, `minicheck` |
| `OPA_GROUNDING_THRESHOLD` | `0.45` | Checker score below which a checker rejects a sentence (calibrated for LettuceDetect) |
| `OPA_GROUNDING_CONTEXT` | `0` | `1` gives anaphoric sentences ("This…") their previous sentence as context |
| `OPA_LETTUCE_MODEL` | `KRLabsOrg/lettucedect-base-modernbert-en-v1` | LettuceDetect model (e.g. the `large` variant) |
| `OPA_MINICHECK_MODEL` | `roberta-large` | MiniCheck model: `roberta-large`, `deberta-v3-large`, `flan-t5-large` |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | — | Enable Langfuse tracing (`LANGFUSE_HOST` is the deprecated alias) |

CLI flags: `--tier auto|light|full`, `--max-subquestions N` (default 4), `--research-steps N` and
`--depth-steps N` (tool-loop budget per agent, default 10), `--run-dir PATH`, `--no-graph`,
`--no-grounding`.

Mixing models per role works well: a cheap model for `RESEARCHER`, a stronger one for `WRITER`,
`CRITIC` and `VERIFIER`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `OPA_MODEL is not set` | `agents/.env` is missing — `cp .env.example .env` and edit it |
| `OPA_BASE_URL is set but no key found` | Export the variable named in `OPA_API_KEY_ENV`, or add it to `OpenPapers/.env` |
| Doctor: `OpenPapers build ... missing` | Run `npm ci && npm run build` in the OpenPapers root |
| Doctor: tool calling fails | The model can't call tools; choose another model |
| Many `provider_failure ... 429` lines, slow research | Scholarly API rate limits: set `SEMANTIC_SCHOLAR_API_KEY`, lower `OPA_MCP_CONCURRENCY=1`, retry later (failures are never cached) |
| Read timeouts or 503s from the LLM gateway | Raise `OPA_TIMEOUT` / `OPA_MAX_RETRIES`; gateways with fallback providers can be slow on first token |
| `model never produced valid ...` JSON errors | Set `OPA_REASONING=1` for reasoning models, or use a stronger model for that role via `OPA_MODEL_<ROLE>` |
| Report exits with code 2 / `ship: false` | Inspect `metrics.json` → `gate` (unknown ids, quote violations) and `cite_check.json` |
| A paper can't be read | `read_paper` needs HTML; arXiv links are converted to `arxiv.org/html/<id>` automatically, but older papers may have no HTML version |
| Windows: `os error 32` during `uv sync` / `uv run` | A run is still using the CLI executable; wait for it or use `uv run --no-sync ...` |
| Windows: `UnicodeEncodeError` printing reports | Set `PYTHONIOENCODING=utf-8` |

## Tests

```bash
uv run pytest
```

The graph tests drive the full and light tiers end to end with a scripted model and a fake
OpenPapers server — asserting routing and fan-in, ledger rejections, patch rejections, citation
repair and the ship gate — with no network. Other tests cover the envelope transport, JSON repair,
math-aware quote matching, the mechanical gates and the graphify extraction.

## Layout

```
src/openpapers_agents/
  config.py           settings from env (provider-agnostic)
  llm.py              model factory, envelope transport, JSON repair, bounded tool loop, usage
  openpapers.py       MCP bridge + research tools rendered from structuredContent
  evidence.py         source store, math-aware quote matching, evidence ledger
  gates.py            surgical patching, citation parsing, quote/number gates, references
  prompts.py          role prompts
  schemas.py          structured outputs between agents
  graph.py            the LangGraph pipeline
  knowledge_graph.py  run artifacts -> graphify graph
  grounding.py        LettuceDetect / MiniCheck checkers and the one-directional vote
  tracing.py          optional Langfuse tracing and trace scores
  runner.py           CLI: openpapers-agents
  doctor.py           CLI: openpapers-doctor
evals/                question sets and the batch eval runner
tests/                offline test suite
```
