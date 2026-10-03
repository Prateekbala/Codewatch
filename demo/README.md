# Demo repository

Use this folder as the seed for a public `pr-agent-demo` repository. Each branch below is a pull request scenario for recordings and manual QA.

| Branch                  | Intent                           | Expected review         |
| ----------------------- | -------------------------------- | ----------------------- |
| `demo/missing-await`    | Drops `await` on async delete    | Bug on the changed line |
| `demo/sql-injection`    | Interpolates user input into SQL | Security finding        |
| `demo/hardcoded-secret` | Commits a live-looking API key   | Security finding        |
| `demo/breaking-api`     | Makes an optional field required | API breaking change     |
| `demo/clean-refactor`   | Template literal refactor        | No findings             |

## Bootstrap

```bash
git init pr-agent-demo && cd pr-agent-demo
cp -R ../demo/src .
git add . && git commit -m "chore: seed demo app"
git branch demo/missing-await
git checkout demo/missing-await
# apply the patch from evals/cases/missing-await.json, commit, open PR
```

Install the GitHub App on the demo repo, set the webhook to your server (see `docs/WEBHOOK.md`), and open pull requests from each branch into `main`.

## Live script (2–3 minutes)

1. Open `demo/missing-await` → show inline comment and sticky summary within a minute.
2. Push a fix commit → show updated review without duplicate comments.
3. Comment `/review` on the PR → show manual re-run.
4. Open `demo/clean-refactor` → show a quiet review with low risk.
5. Run `pnpm eval` locally and show precision/recall in the terminal.
