# PR Review Agent — Architecture

**Scope:** GitHub pull requests only  
**Stack:** TypeScript (Node ≥24), LangChain.js, LangGraph, Octokit (GitHub App), Hono, Commander, Zod, Vitest  
**Status:** MVP as-built (October 2026). Long-range ideas from the original design are in [§12 Future](#12-future-not-implemented).

Companion docs: `docs/MVP-PLAN.md` (scope cuts), `PLAN (1).md` (phase roadmap), `docs/WEBHOOK.md` (App setup).

---

## 1. Goals and non-goals

### Goals

- Post pull request reviews developers can trust: a few inline comments on real issues plus one updatable summary.
- **Precision over volume.** Caps, grounding, verification, and evals exist to keep noise low.
- Use context beyond the raw diff: repo rules, linked issues, CI check output, prior bot findings on the same PR.
- Treat all PR-authored text as untrusted (prompt-injection defense).
- Bound cost and tokens per run; record usage on every invocation.
- One **core** library shared by the CLI, webhook server, and tests.

### Non-goals (current MVP)

- GitLab, Bitbucket, or other hosts.
- Queue workers, Postgres run history, Pinecone retrieval, shadow mode, multi-tenant admin.
- Specialist reviewer fleet, triage node, agent tool loops, `/ask`, `/improve`, `/similar_issue`, `/config` slash commands.
- Auto-merge, auto-fix without human acceptance, or executing PR code on trusted runners.
- Replacing human review; this is a first-pass reviewer.

---

## 2. Design principles

| Principle | MVP implementation |
| --- | --- |
| Transport-agnostic core | All product logic in `src/core/`; `cli/` and `server/` call `runCommand`. |
| Fast webhook ack | Hono returns `202` immediately; review runs in-process after the response (no Redis queue yet). |
| Deterministic + LLM | CI check annotations become `source: ci` findings; LLM findings go through a verifier before publish. |
| Structured output only | `LlmGateway.invokeStructured` + Zod schemas; repair retries on schema failure. |
| Generate then filter | Review units → merge → ground → confidence/severity filter → verify → summarize. |
| Bounded work | Per-run token/USD budgets, `maxGraphSteps`, `maxConcurrency`, diff token budgets, inline comment cap. |
| Idempotent, cancellable | Finding fingerprints + HTML markers; supersede aborts in-flight runs; publisher refuses stale head SHA. |
| Config by schema | Layered YAML + Zod; invalid layers ignored with warnings. |

---

## 3. System overview (as-built)

```
                    ┌─────────────────────────────────────────┐
                    │              src/core/                   │
                    │  config · diff · context · llm · graph   │
                    │  github client · commands (publish)    │
                    └───────────────────┬─────────────────────┘
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                         │
              ▼                         ▼                         ▼
     ┌────────────────┐      ┌─────────────────┐      ┌─────────────────┐
     │  CLI (Commander)│      │ Hono server      │      │ Vitest + evals  │
     │  describe       │      │ POST /webhooks/  │      │ scripted LLM,   │
     │  review         │      │     github       │      │ fixtures, msw   │
     │  config show    │      │ GET /healthz     │      └─────────────────┘
     └────────┬────────┘      └────────┬────────┘
              │                        │
              │                        │ verify signature
              │                        │ dedupe X-GitHub-Delivery
              │                        │ skip rules / slash cmds
              │                        ▼
              │               ┌─────────────────┐
              └──────────────►│  runCommand()   │
                              │  review | describe│
                              └────────┬────────┘
                                       │
                                       ▼
                              GitHub REST API
                              (App installation token)
```

**Authentication:** GitHub App (`GITHUB_APP_ID` + private key) for production webhooks and multi-repo CLI; `GITHUB_TOKEN` for local CLI only.

**Persistence:** None in the hot path. Optional JSON run records via CLI `--record-dir`. Eval reports written to `evals/reports/`.

---

## 4. Entry points

### 4.1 CLI (`src/cli/`)

| Command | Behavior |
| --- | --- |
| `describe <pr>` | LangGraph describe graph; updates managed `pr-agent:describe` section in PR body; optional `--update-title`. |
| `review <pr>` | Full review graph; posts inline review + sticky `pr-agent:review` summary unless `--dry-run`. |
| `config show` | Effective merged configuration. |

Global flags: `--config`, `--log-level`, `--json`, `--record-dir` (review).

### 4.2 Webhook server (`src/server/`)

| Route | Behavior |
| --- | --- |
| `GET /healthz` | Liveness JSON `{ ok: true }`. |
| `POST /webhooks/github` | Validates `X-Hub-Signature-256`, dedupes `X-GitHub-Delivery`, dispatches work. |

**Events handled:**

- `pull_request` — `opened`, `synchronize`, `reopened`, `ready_for_review` → enqueue in-process `review` (if `server.autoReviewOnOpen`).
- `issue_comment` — `created` on a PR → `/review` or `/describe` when the author is a collaborator.

**In-process orchestration:**

- `DeliveryCache` — LRU of delivery IDs (size `server.maxDeliveryCache`).
- `RunSupervisor` — one active run per `owner/repo#number`; new head SHA aborts the previous `AbortSignal`.
- `runPullRequestJob` — calls `runCommand` with installation-scoped `GitHubClient`.

**Skip rules:** closed PR, draft, bot author (`authorType === "Bot"` or login ending in `[bot]`).

Run: `pnpm dev:server` or `node dist/server/index.js` after `pnpm build`. See `docs/WEBHOOK.md`.

---

## 5. Command pipeline (`core/commands/run.ts`)

Every run shares the same pipeline:

1. Resolve `PullRequestRef` → fetch PR (unless caller passes `client` for webhook jobs).
2. Load `.pr-agent.yaml` from the default branch into the config layer stack.
3. Build `CoreServices`: Octokit client, `LlmGateway`, `CostTracker`, token counter, logger with `runId`.
4. Execute handler:
   - **describe** → `runDescribe` → `publishDescribe` (managed body section).
   - **review** → `runReview` → `publishReview` (inline comments + sticky summary, usage footer).
5. Return outcome with `usage`, `durationMs`, `promptHashes`, `configIssues`.

Handlers respect `dryRun`, `signal` (cancellation), and optional injected `client`.

---

## 6. Context builder (`core/context/`)

`buildReviewContext` loads in parallel:

| Input | Used for |
| --- | --- |
| `listFiles`, `listCommits` | Diff preparation and prompts |
| `listReviewComments` | Prior findings (fingerprint markers in bodies) |
| `listCheckRuns` + `listCheckAnnotations` | `ciSummary` text and `checkAnnotations` for CI findings |
| `getFileContent` on `AGENTS.md` / `CLAUDE.md` | `repoRules` (truncated) |
| Linked issues from title/body | `extractLinkedIssues` + `getIssue` → `linkedIssues` block |

Output type: `ReviewContext` (PR, files, commits, rules, linked issues, CI summary, prior findings, raw annotations).

Repo config layer: `repo-config.ts` reads `.pr-agent.yaml` from the default branch.

---

## 7. Diff engine (`core/diff/`)

Responsibilities:

- Classify and parse unified patches; `DiffLineIndex` for LEFT/RIGHT line validation (grounding).
- Ignore globs (lockfiles, generated assets, etc.) and `allowGlobs` overrides.
- Extend hunks with head-commit file content when useful (`extend.ts`).
- Token budget: `prepareDiff` fits files/units under model context minus prompt overhead.
- Render for the model: `R12:+line` / `L8:-line` format.

Review fan-out: multiple `reviewUnit` nodes via LangGraph `Send`, one unit per budget chunk.

---

## 8. Review graph (`core/graph/review/`)

LangGraph state machine (`createReviewGraph`):

```
START
  → fetchContext
  → prepareDiff
  → reviewUnit (Send fan-out, per unit; failures recorded, do not abort whole PR)
  → mergeFindings      (LLM candidates → promoteFinding → dedupe by fingerprint)
  → mergeCiFindings    (annotations on changed paths → source: ci)
  → groundFindings     (drop or flip side if line not in shown diff)
  → filterFindings     (minConfidence, severityThreshold; CI bypasses confidence floor)
  → verifyFindings     (per-LLM-finding verifier role; skippable via review.enableVerifier)
  → summarize
  → END
```

**LLM roles (config `models.*`):**

| Role | Default use |
| --- | --- |
| `reviewer` | Structured findings per review unit |
| `verifier` | keep/drop + reason per LLM finding |
| `summarizer` | `ReviewSummary` (overview, risk, highlights, file groups) |

On summarizer failure, a deterministic fallback summary is used. `riskLevel` is floored to the worst finding severity.

**Schemas:**

- `LlmFinding` — model output (no `id`; nullable `suggestion`).
- `Finding` — promoted row with fingerprint `id`, `source` (`llm` \| `ci` \| …).
- `ReviewResult` — findings, summary, notices, stats, prompt hashes.

**Prompts:** versioned templates under `core/prompts/templates/`; SHA-256 hashes recorded per run. Untrusted tags neutralized in user-visible PR fields (`UNTRUSTED_TAGS`).

---

## 9. Describe graph (`core/graph/describe/`)

Single-pass graph: prepare diff → structured `DescribeOutput` (title, type, summary, walkthrough, risks) → format managed section. Exercises the same diff and LLM stack as review with a smaller schema.

---

## 10. Publishing and idempotency

### 10.1 Managed sections (`core/github/markers.ts`)

HTML comments delimit bot-owned content:

- `<!-- pr-agent:describe:start/end -->`
- `<!-- pr-agent:review:start/end -->`
- `<!-- pr-agent:finding:<16hex> -->` per finding for dedupe

`upsertManagedSection` replaces or appends without touching author prose outside markers.

### 10.2 Review publish (`core/commands/review.ts`)

1. Re-fetch PR; if `headSha` changed → `status: stale`, no writes.
2. Skip findings whose ids already appear in review or sticky comments.
3. Anchor inline comments via `DiffLineIndex.validateRange`; cap count `review.maxInlineComments`.
4. `createReview` with `COMMENT` event; on `422`, fall back to summary-only.
5. Create or `updateIssueComment` for sticky summary (`formatReview` + optional run cost footer).

### 10.3 Fingerprints (`core/graph/review/fingerprint.ts`)

Stable 16-hex id from category, path, lines, normalized title. `deduplicateFindings` merges overlaps on the same path/category/side within a small line window.

---

## 11. LLM gateway (`core/llm/`)

- **Adapters:** OpenAI and Anthropic via LangChain; factory from env API keys.
- **Structured calls:** `invokeStructured` with schema repair loop, fallback models, per-call timeout, `CostTracker` budgets (`BudgetExceededError` aborts without silent fallback).
- **Pricing:** optional per-model $/MTok in config; unpriced models still report tokens.
- **Strict JSON schema:** model-facing Zod schemas avoid OpenAI-unsupported keywords (`minLength`, `int`, etc.); constraints enforced after parse (e.g. title length in `promoteFinding`).

---

## 12. Configuration (`core/config/`)

Layers (last wins): defaults → optional org/installation file (future) → repo `.pr-agent.yaml` → CLI `--config`.

Representative keys:

| Key | Purpose |
| --- | --- |
| `ignore.globs` / `allowGlobs` | Diff inclusion |
| `diff.*` | Context lines, file caps, unit token budget |
| `review.maxInlineComments` | Inline cap (overflow in collapsed summary) |
| `review.minConfidence`, `review.severityThreshold` | Post-filter |
| `review.enableVerifier` | Second-pass keep/drop |
| `review.maxConcurrency` | Review units + verifier batching |
| `server.autoReviewOnOpen` | Webhook auto-review |
| `models.reviewer` / `verifier` / `summarizer` | Provider + model id |
| `budgets.perRunUsd`, `budgets.perRunTokens` | Hard stop |

Environment: `src/core/config/env.ts` — App credentials, webhook secret, LLM keys, `PORT`, `LOG_LEVEL`.

---

## 13. Security model

| Topic | MVP behavior |
| --- | --- |
| Credentials | GitHub App installation tokens; webhook HMAC; secrets in env only. |
| Prompt injection | System prompts forbid obeying PR text; `neutralizeTags` on untrusted fields; eval cases for adversarial titles/bodies. |
| Authorization | Slash commands only for collaborators (`repos.checkCollaborator`). |
| Fork PRs | Review uses API-fetched patches only; no checkout or test execution of PR code. |
| Stale posts | Aborted runs and publisher head-SHA check prevent comments on outdated commits. |
| Secrets in diffs | Relies on model + security category prompts; no separate redaction pipeline yet. |

---

## 14. Observability

- **Logging:** Pino, JSON in production; `runId`, repo, PR number, head SHA on command runs.
- **Cost:** `CostSummary` per run (by node and by model); printed in CLI and sticky review footer.
- **Not in MVP:** LangSmith, OpenTelemetry, dashboards, acceptance-rate tracking.

---

## 15. Testing and evaluation

| Layer | Location | Focus |
| --- | --- | --- |
| Unit | `tests/diff`, `tests/config`, `tests/graph`, `tests/server` | Parsing, grounding, skip rules, signatures |
| Integration | `tests/commands`, `tests/github` (msw) | End-to-end command and API shapes |
| Graph | Scripted `ScriptedLlm` | Fan-out, filter, verifier, CI merge |
| Evals | `evals/cases/*.json`, `pnpm eval` | Precision/recall vs labeled line ranges; baseline compare |

Eval runner uses in-memory `MemoryGitHubClient` and the real review graph. Reports land in `evals/reports/`; baselines documented in `evals/baselines/README.md`.

---

## 16. Deployment

- **Build:** `pnpm build` → `dist/` + copied prompt templates.
- **Container:** `Dockerfile` (Node 24 Alpine, production deps only).
- **Fly.io:** `fly.toml` with `/healthz` check (example; adjust app name).
- **Local webhooks:** smee.io → `localhost:PORT` per `docs/WEBHOOK.md`.

Horizontal scale of the webhook process is possible but **in-memory** dedupe and run locks are per instance; multiple replicas need sticky routing or external state before production scale-out.

---

## 17. Repository layout

```
src/
  core/
    config/          Zod schema, env, layered loader, defaults
    context/         ReviewContext builder, linked issues, repo config
    diff/            parse, filter, extend, budget, prepare, line index
    github/          Octokit client, App factory, markers, types
    graph/
      describe/      describe graph, format, prompts
      review/        review graph, schema, verify, ci-findings, format, fingerprint
    llm/             gateway, adapters, cost, tokens, errors
    prompts/         loader + templates (*.md)
    commands/        run, review publish, describe publish, config helpers
    logging/         logger, runId
    runtime.ts       wires env, github factory, LLM factory
    services.ts      CoreServices bag
  server/            Hono app, webhook plumbing, supervisor, delivery cache
  cli/               Commander entry, JSON/text output
evals/               cases, runner, scoring, CLI, reports/
demo/                seed instructions for public demo repo
docs/                MVP-PLAN, WEBHOOK
tests/               vitest suites
```

There is no `worker/`, `db/`, or `vectors/` package in the MVP tree.

---

## 18. Future (not implemented)

Planned in `PLAN (1).md` but cut or deferred for MVP:

- **Queue + worker** — BullMQ/SQS, Postgres `runs` / `findings` / `feedback_events`, webhook dedupe in Redis.
- **Precision engine** — triage, parallel specialists, embedding dedupe, ranker, suggestion verification pipeline.
- **Pinecone** — issue and code indexes, `/similar_issue`, agent tools (`readFileAtRef`, `searchCode`, …).
- **Feedback loop** — learned suppression rules, acceptance metrics, canary/shadow mode.
- **Check runs** — optional merge gating, richer CI integration beyond annotations.
- **Slash commands** — `/ask`, `/config`, `/improve` as separate graphs.

When adding any of these, keep the rule: **extend `core/`, keep transports thin**, and gate prompt/graph changes on `pnpm eval`.

---

## 19. Key decisions (MVP)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Webhook execution | In-process after `202` | Fastest path to demo; queue when load or multi-instance demands it |
| Single reviewer + verifier | Not five specialists | Cost/latency; verifier gives most precision upside |
| CI signal | GitHub check annotations only | No Semgrep/lint runners to operate |
| Finding identity | Hash fingerprint + marker comments | Idempotent GitHub writes without a database |
| Grounding | Diff line index before publish | Reduces invalid inline comments; 422 fallback to summary |
| Config | Zod + `.pr-agent.yaml` | Repo-specific caps without redeploying the server |
| Evals | Synthetic + growing real cases | Repeatable quality signal for demos and CI gates |

---

## 20. Document map

| Document | Audience |
| --- | --- |
| `ARCHITECTURE.md` (this file) | Engineers: as-built system and extension points |
| `docs/IMPLEMENTATION.md` | How each stage works in depth (theory and invariants) |
| `docs/MVP-PLAN.md` | What shipped vs cut for the demo |
| `PLAN (1).md` | Original multi-phase roadmap |
| `README.md` | Quick start, commands, deploy one-liner |
| `docs/WEBHOOK.md` | GitHub App permissions and smee setup |
