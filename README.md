<h1 align="center">CodeWatch</h1>

<p align="center">
  <img src="public/Repo_logo.svg" alt="CodeWatch Logo" width="120" />
</p>

<p align="center">
  An autonomous GitHub pull request reviewer built on LangGraph and TypeScript.<br/>
  Structured findings · inline comments · sticky summary · cost per run.
</p>

<p align="center">
  <a href="https://hub.docker.com/r/prateekbala28/codewatch">
    <img src="https://img.shields.io/docker/pulls/prateekbala28/codewatch?label=Docker%20Pulls&logo=docker" alt="Docker Pulls" />
  </a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen" alt="Node >= 24" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
</p>

---

## What it does

CodeWatch connects to your GitHub repositories and reviews pull requests the way a senior engineer would — catching real bugs, security issues, and bad patterns, not generating noise.

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
  <img src="public/CodeWatch Architecture Overview.png" alt="Architecture diagram" width="720" />
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

## Running with Docker

The image is published on Docker Hub at [`prateekbala28/codewatch`](https://hub.docker.com/r/prateekbala28/codewatch). No need to clone the repo or install Node — just pull and run.

### 1. Pull the image

```bash
docker pull prateekbala28/codewatch:latest
```

### 2. Create a `.env` file

Create a file called `.env` in any directory with your credentials:

```bash
# LLM provider — at least one required
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=        # optional
GROQ_API_KEY=             # optional

# GitHub App credentials
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=your-webhook-secret

# Optional
LOG_LEVEL=info
PORT=3000
```

> For the private key, replace literal newlines with `\n` so it fits on one line, or use `GITHUB_APP_PRIVATE_KEY_PATH` and mount the key file as a volume.

### 3. Run the container

```bash
docker run -d \
  --name codewatch \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  prateekbala28/codewatch:latest
```

### 4. Verify it's running

```bash
curl http://localhost:3000/healthz
# → {"ok":true}
```

### Stop / restart

```bash
docker stop codewatch
docker start codewatch
```

### View logs

```bash
docker logs -f codewatch
```

### Update to the latest image

```bash
docker pull prateekbala28/codewatch:latest
docker stop codewatch && docker rm codewatch
# re-run the docker run command from step 3
```

---

## Slash commands

Once the App is installed on a repo, collaborators can trigger reviews from PR comments:

```
/review    — trigger a fresh review on the current head SHA
/describe  — regenerate the PR description (title, type, walkthrough)
```

Bot authors and non-collaborators are automatically rejected.

---

## Per-repo configuration

Drop a `.pr-agent.yaml` file on the **default branch** of any repository to customize behaviour. Policy lives in the repo, not in the bot deployment.

```yaml
review:
  maxInlineComments: 10       # cap on inline comments (overflow goes to summary)
  enableVerifier: true        # second-pass keep/drop per finding (recommended)
  verifierMode: single        # `agentic` lets the verifier read files and search code
  maxInvestigations: 8        # findings investigated with tools per run (agentic only)
  maxToolCallsPerReviewer: 5  # tool calls per investigated finding
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
  perRunUsd: 0.50             # hard stop — run is aborted, not silently truncated
  perRunTokens: 200000
```

Configuration layers (last wins): built-in defaults → `.pr-agent.yaml` on default branch → CLI `--config` flag. Invalid layers are dropped entirely and logged.

---

## Local development

**Prerequisites:** Node ≥ 24, pnpm

```bash
git clone https://github.com/Prateekbala/Codewatch.git
cd Codewatch
pnpm install
cp .env.example .env
# Fill in .env with your keys
```

### CLI usage

```bash
# Dry run — review to stdout, nothing posted to GitHub
pnpm dev review owner/repo#12 --dry-run

# Post the review as inline comments + sticky summary
pnpm dev review owner/repo#12

# Generate a PR description
pnpm dev describe owner/repo#12 --dry-run

# Inspect the effective merged configuration
pnpm dev config show

# Fetch and print raw PR data (smoke test)
pnpm smoke:github owner/repo#12
```

Global flags: `--config <file>`, `--log-level debug|info|warn|error`, `--json`, `--record-dir <dir>`

### Run the webhook server locally

```bash
# With hot reload
pnpm dev:server
```

Use [smee.io](https://smee.io) to forward GitHub webhook events to your local server. See `docs/WEBHOOK.md`.

### Build the Docker image yourself

```bash
docker build -t codewatch .
docker run -p 3000:3000 --env-file .env codewatch
```

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

## Evals

The eval suite runs the real review graph against synthetic fixture PRs and scores precision, recall, and F1 against labeled line ranges.

```bash
pnpm eval
```

14 synthetic cases: missing `await`, SQL injection, hardcoded secret, breaking API change, off-by-one error, weak crypto, open redirect, empty catch, prompt injection, and clean PRs.

| Configuration | Precision | Recall | Cost/PR |
| --- | --- | --- | --- |
| Reviewer only | 45–60% | 35–45% | lowest |
| + single-pass verifier | 55–70% | 30–42% | +10–20% |
| + agentic verifier | 65–78% | 30–42% | +30–80% |

