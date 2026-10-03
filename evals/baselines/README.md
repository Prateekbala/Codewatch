# Eval baselines

Save a trusted `pnpm eval` report JSON here and compare later runs:

```bash
pnpm eval --label baseline
cp evals/reports/<timestamp>-baseline.json evals/baselines/main.json
pnpm eval --baseline evals/baselines/main.json
```

The command exits with code `1` when precision or recall drops more than `--tolerance` (default `0.05`) versus the baseline.
