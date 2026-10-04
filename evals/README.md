# Review evals

Measures review quality (precision, recall, F1) and cost on a fixed set of pull requests.

## Run

```bash
pnpm eval
pnpm eval --case missing-await --case sql-injection
pnpm eval --label gpt-5-baseline
pnpm eval --baseline evals/baselines/main.json
pnpm eval --config path/to/config.yaml
```

Requires the provider API keys used by the configured models. Each run writes a JSON report to `evals/reports/` (ignored by git). Exit code is `1` when any case errored or when precision or recall dropped more than `--tolerance` (default `0.05`) versus the baseline.

### Single-pass vs agentic verifier

```bash
pnpm eval --config evals/configs/single.yaml  --label single
pnpm eval --config evals/configs/agentic.yaml --label agentic --baseline evals/reports/<single-report>.json
```

The agentic config turns on the tool-using investigator (`review.verifierMode: agentic`). `guarded-elsewhere` (a clean PR whose guard lives in another file) and `caller-passes-user-input` (confirmation needs the caller) are the cases where it should help. Report precision, recall, and cost per case for both, since tool use costs extra tokens.

### Degraded runs are not results

If a review unit fails (provider rate limit, timeout), the case is marked `DEGR`, the report prints a warning, and the command exits with code `1`. Scores from such a run only measure the outage. Rerun with `--concurrency 1`, a higher `llm.maxRetries`, or a key with higher rate limits (the Groq free tier allows only 8,000 tokens per minute per model, which is not enough for a full run).

To record a baseline, copy a report you trust into `evals/baselines/`.

## Cases

Each file in `evals/cases/` is a self-contained pull request:

| Field      | Meaning                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------- |
| `pr`       | Title, description, author                                                                  |
| `commits`  | Commit messages                                                                             |
| `files`    | Path and unified-diff patch per changed file                                                |
| `contents` | Optional head-commit file contents for hunk extension                                       |
| `expected` | Ground-truth findings: path, line range, optional category. Empty means the change is clean |

A reported finding matches an expected one when the path is equal and the line ranges overlap within two lines. Each expected finding matches at most once. Everything else reported counts as a false positive, so clean cases measure noise directly.

## Growing the set

The bundled cases are synthetic and exist to exercise the harness and catch regressions in prompts. Real confidence needs 20 to 30 curated cases from your own repositories: keep the pull request diff, label the real defects at the lines where a reviewer would comment, and include clean pull requests and adversarial descriptions.

Never put code or secrets you are not allowed to store into a case.
