<p align="center">
  <img src="public/Repo_logo.png" alt="PR Review Agent" width="180" />
</p>

<h1 align="center">PR Review Agent</h1>

<p align="center">
  An autonomous GitHub pull request reviewer built on LangGraph and TypeScript.<br/>
  Structured findings · inline comments · sticky summary · cost per run.
</p>

---

## What it does

PR Review Agent connects to your GitHub repositories and reviews pull requests the way a senior engineer would — catching real bugs, security issues, and bad patterns, not generating noise.

On every review it:

- Loads the PR context and diff, respects repo rules from `AGENTS.md` / `CLAUDE.md`
- Runs a multi-unit LLM review (fan-out across large diffs) with a dedicated verifier pass to drop speculative findings
- Merges CI check annotations on changed lines as first-class findings
- Posts up to `review.maxInlineComments` inline comments and one sticky summary comment between `pr-agent:review` markers
- Deduplicates findings on re-runs — pushes and redeliveries never create duplicate threads
- Refuses to publish when the head SHA has moved mid-run

---

## Architecture

<p align="center">
  <img src="public/AGENT_DIAGRAM.png" alt="Architecture diagram" width="720" />
</p>

The system has a **transport-agnostic core** (`src/core/`) shared by three shells:

| Shell | Trigger |
| --- | --- |
| CLI | `pnpm dev review owner/repo#N` |
| Webhook server | GitHub App event → `POST /webhooks/github` |
| Eval runner | Synthetic fixture JSON for offline quality measurement |

All shells call the same `runCommand()` → review graph pipeline. The core never knows which shell invoked it.

**Review graph stages:**

```
fetchContext → prepareDiff → reviewUnit (fan-out)
  → mergeFindings → mergeCiFindings → groundFindings
  → filterFindings → verifyFindings → summarize
```

Each finding is grounded against the actual diff line index before publishing. Ungrounded findings (model hallucinated a line number) are dropped, not posted.

---

## Quick start

**Prerequisites:** Node ≥ 24, pnpm

```bash
git clone https://github.com/your-org/pr-review-agent.git
cd pr-review-agent
pnpm install
cp .env.example .env
```

Set the required environment variables in `.env`:

```bash
# Required for all modes
OPENAI_API_KEY=sk-...

# CLI with a personal token
GITHUB_TOKEN=ghp_...

# CLI or server with a GitHub App
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
GITHUB_APP_INSTALLATION_ID=12345678   # CLI only

# Server mode
GITHUB_WEBHOOK_SECRET=your-webhook-secret
```

---

## Usage

### CLI

```bash
# Dry run — review to stdout, nothing posted to GitHub
pnpm dev review owner/repo#12 --dry-run

# Post the review as inline comments + sticky summary
pnpm dev review owner/repo#12

# Generate a PR description (title, type, walkthrough)
pnpm dev describe owner/repo#12 --dry-run

# Inspect the effective merged configuration
pnpm dev config show

# Fetch and print raw PR data (smoke test)
pnpm smoke:github owner/repo#12
```

Global flags: `--config <file>`, `--log-level debug|info|warn|error`, `--json`, `--record-dir <dir>` (saves run records).

### Webhook server

```bash
# Development (with hot reload)
pnpm dev:server

# Production
pnpm build && pnpm start

# Docker
docker build -t pr-review-agent .
docker run -p 3000:3000 --env-file .env pr-review-agent
```

The server handles:

| Event | Action |
| --- | --- |
| `pull_request` opened / synchronize / reopened / ready_for_review | Auto-review (if `server.autoReviewOnOpen: true`) |
| `issue_comment` `/review` or `/describe` | Triggered review by a collaborator |
| `GET /healthz` | Liveness check |

See `docs/WEBHOOK.md` for GitHub App permissions and smee.io tunnel setup for local development.

### Slash commands (via PR comment)

Collaborators only. Bot authors and drive-by commenters are rejected.

```
/review    — trigger a fresh review on the current head
/describe  — regenerate the PR description
```

---

## Configuration

Drop a `.pr-agent.yaml` file on the **default branch** of any repository. Policy lives in the repo, not in the bot deployment.

```yaml
review:
  maxInlineComments: 10       # cap on posted inline comments (overflow in summary)
  enableVerifier: true        # second-pass keep/drop per finding (recommended)
  minConfidence: 0.6          # drop findings below this threshold
  severityThreshold: low      # minimum severity to post
  maxConcurrency: 4           # parallel review units and verifier batches

diff:
  maxFiles: 30                # files included in the diff
  contextLines: 4             # extra lines around each hunk

ignore:
  globs:
    - "pnpm-lock.yaml"
    - "*.generated.ts"

models:
  reviewer:
    provider: openai
    model: gpt-4o
  verifier:
    provider: openai
    model: gpt-4o-mini
  summarizer:
    provider: openai
    model: gpt-4o-mini

budgets:
  perRunUsd: 0.50             # hard stop (no silent fallback)
  perRunTokens: 200000
```

Configuration layers (last wins): built-in defaults → `.pr-agent.yaml` on default branch → CLI `--config` flag. Invalid layers are dropped entirely and logged — they never silently corrupt the config.

---

## Evals

The eval suite is the primary quality gate. It runs the real review graph against synthetic fixture PRs and scores precision, recall, and F1 against labeled line ranges.

```bash
pnpm eval
```

Example output:

| Metric | Value |
| --- | --- |
| Cases | 12 synthetic PRs (bugs, security, clean, adversarial) |
| Precision | Reported per run |
| Recall | Reported per run |
| Cost | Tokens and USD per case in the JSON report |

Record a baseline after a clean run, then compare future runs against it to catch regressions before they reach production. See `evals/baselines/README.md`.

Eval fixtures cover: missing `await`, SQL injection, hardcoded secret, breaking API change, off-by-one error, weak crypto, open redirect, empty catch, prompt injection, and clean PRs.

---

## Quality gate

Runs typecheck, lint, format check, and all tests:

```bash
pnpm check
```

Individual commands:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:coverage
```

---

## Deployment

The server is a single Node process. Deploy anywhere that runs Docker or Node 24.

**Fly.io** (example — adjust `app` name in `fly.toml`):

```bash
fly secrets set OPENAI_API_KEY=... GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY=... GITHUB_WEBHOOK_SECRET=...
fly deploy
```

**Docker:**

```bash
docker build -t pr-review-agent .
docker run -p 3000:3000 --env-file .env pr-review-agent
```

The `/healthz` endpoint returns `{ "ok": true }` and is used as the liveness check.

> **Note on scaling:** In-memory dedupe and per-PR run locks are per-process. Multiple replicas need sticky routing or external state. For a single-instance deployment this is not an issue.

---

## Project status

| Area | State |
| --- | --- |
| Core, CLI, diff engine | Done |
| Review graph (fan-out, grounding, verifier) | Done |
| CI findings from check annotations | Done |
| Webhook server + skip rules + slash commands | Done |
| Evals (precision/recall, baseline comparison) | Done |
| Dockerfile + Fly.io deploy | Done |
| Queue / Postgres / Redis | Out of scope (`docs/MVP-PLAN.md`) |
| Pinecone retrieval, specialist fleet, agent tools | Out of scope |

---

## Repository layout

```
src/
  core/           All product logic (config, diff, context, llm, graph, github, commands)
  server/         Hono webhook server, supervisor, delivery cache
  cli/            Commander entry point
evals/            Eval runner, scoring, fixture cases, reports
demo/             Seed instructions for a public demo repository
docs/             MVP-PLAN.md, WEBHOOK.md, IMPLEMENTATION.md
tests/            Vitest unit, integration, and graph tests
```

---

## Documentation

| Document | What it covers |
| --- | --- |
| `ARCHITECTURE.md` | Component map, design principles, security model, extension points |
| `docs/IMPLEMENTATION.md` | How each graph stage works (theory, invariants, data flow) |
| `docs/MVP-PLAN.md` | What shipped vs what was deliberately cut for the MVP |
| `docs/WEBHOOK.md` | GitHub App setup, permissions, smee.io for local development |
| `evals/README.md` | Running the eval suite and recording baselines |
