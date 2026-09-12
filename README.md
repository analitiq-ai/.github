# .github

Org-wide shared GitHub Actions tooling for `analitiq-ai` repositories.

This repo hosts reusable workflows (`on: workflow_call`) and the scripts they
depend on, so CI logic shared across repos is defined once and referenced
from a thin caller workflow in each consuming repo, rather than copy-pasted.

## Contents

- `.github/workflows/ai-review.yml` — reusable workflow: an AI-generated code
  review posted as inline PR comments, triggered by a `/review` comment.

## `ai-review.yml`

Cost at Kimi K2.5 rates: roughly $0.005 for a first review, $0.001 per
re-review (only the incremental diff since the last review is sent).

### Wiring it into a consumer repo

1. The `OPEN_ROUTER_KEY` org secret already covers every repo it's scoped to
   — nothing to add per repo.
2. Add a caller workflow, e.g. `.github/workflows/ai-review.yml`:

   ```yaml
   name: AI Review

   on:
     issue_comment:
       types: [created]

   permissions:
     contents: read
     issues: write
     pull-requests: write

   jobs:
     review:
       if: >
         github.event.issue.pull_request &&
         github.event.comment.user.login == 'Analitiq-Bot' &&
         startsWith(github.event.comment.body, '/review')
       uses: analitiq-ai/.github/.github/workflows/ai-review.yml@main
       secrets:
         OPEN_ROUTER_KEY: ${{ secrets.OPEN_ROUTER_KEY }}
       # with:
       #   model: moonshotai/kimi-k2-thinking   # override the default below
   ```

   `issues: write` is required, not optional: the reusable workflow's own
   `permissions:` can only narrow what its caller grants, never widen it, and
   the eyes-reaction/failure-comment ack (below) posts through Issues-API
   endpoints that `pull-requests: write` doesn't cover. Without it the ack
   silently never appears — the call is best-effort and won't fail the run.

   The `if:` is the actual security boundary: on a public repo, anyone can
   comment `/review` on a PR, so the job only runs when the comment's author
   is the `Analitiq-Bot` account. Don't drop this check when copying the
   caller elsewhere.

### The loop

```
/review            → 👀 once OpenRouter accepts the request, then
                     inline findings + summary + hidden SHA
  ↓  you fix, push
/review            → diffs only the fix commits; marks prior findings
                     RESOLVED / NOT_ADDRESSED / PARTIALLY_ADDRESSED; flags anything new
/review full       → fresh whole-PR pass when incremental has drifted
```

The 👀 is best-effort (a missing `issues: write` on the caller drops it
silently, logged only as an Actions `::warning::`) — treat its absence as a
hint, not proof of failure. No 👀 and no review within a minute or so usually
means something failed before OpenRouter was reached (bad diff, missing
secret, missing permission) — check the run. If OpenRouter itself rejected
the request (no credits, bad key, model slug typo'd) or returned something
unusable, a PR comment says so directly instead of leaving only a red
Actions run.

### Operating notes

- Treat PR diffs as untrusted input — a diff can contain text aimed at the
  model. The reusable workflow never checks out a PR's own commits as its
  working tree (only fetches the objects, for diffing); the scripts it runs
  always come from a separate checkout of this repo's own `main` branch, so
  a PR can't rewrite the reviewer to exfiltrate secrets. `main` is a floating
  ref, not a pinned tag/SHA — consider tagging a release once this stabilizes
  and pinning consumers' `uses:` and this checkout to it together.
- Size caps in `build-diff.sh` budget whole files rather than truncating —
  a cut-off hunk gives the model a fragment it hallucinates about or anchors
  a comment to a line that doesn't exist. Generated/lockfile diffs are
  excluded outright: findings on those go unactioned, and a huge diff pushes
  the code you care about into the part of the context window where
  retrieval is weakest.
- Pin the model in the caller's `with: model:` (defaults to
  `moonshotai/kimi-k2.5`) — OpenRouter slugs move. If reviews feel shallow,
  move to `moonshotai/kimi-k2-thinking` before touching the prompt; if
  they're noisy, tighten `.github/scripts/review.sh`'s system prompt rather
  than switching models — false positives are mostly a prompt-threshold
  problem.
- Pilot on a repo's historical PRs and count false positives before trusting
  it on live work.
