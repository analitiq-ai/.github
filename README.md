# .github

Org-wide shared GitHub Actions tooling for `analitiq-ai` repositories.

This repo hosts reusable workflows (`on: workflow_call`) and the scripts they
depend on, so CI logic shared across repos is defined once and referenced
from a thin caller workflow in each consuming repo, rather than copy-pasted.

## Contents

- `.github/workflows/ai-review.yml` — reusable workflow: an AI-generated code
  review posted as inline PR comments, triggered by a `/review` comment.

## `ai-review.yml`

Cost at glm-5.3-flash rates ran a few cents a review in benchmarking without
tool use; each investigation round the model takes (see Tools, below) is one
more full request, so a review that reads several files costs more than one
that doesn't — there's no per-run cost cap yet, only the round cap described
below.

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
   never appears — logged only as an Actions `::warning::`, since the call
   is best-effort and won't fail the run.

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

The 👀 is best-effort (a missing `issues: write` on the caller drops it,
logged only as an Actions `::warning::`) — treat its absence as a hint, not
proof of failure. No 👀 and no review within a minute or so usually
means something failed before OpenRouter was reached (bad diff, missing
secret, missing permission) — check the run. If OpenRouter itself rejected
the request (no credits, bad key, model slug typo'd) or returned something
unusable, a PR comment says so directly instead of leaving only a red
Actions run.

### Tools

A diff alone can't carry repo-wide convention — whether a referenced field
exists, whether a naming rule holds elsewhere, what a function it didn't see
the definition of actually does. `.github/scripts/tools.sh` gives the model
three read-only tools, backed entirely by git plumbing against the PR's head
commit, never a working-tree checkout:

- `read_file(path)` — `git show <pr_head>:<path>`
- `grep(pattern, glob?)` — `git grep` at `<pr_head>`
- `list_files(glob?)` — `git ls-tree` at `<pr_head>`

Each result is capped (8 KB for `read_file`/`grep`, 4 KB for `list_files`)
and timed out at 10s; a bad or malformed tool call (an invalid path, unparsable
arguments) returns an `error: ...` string to the model rather than failing
the review. The review runs in two phases so structured output and tool
calling never have to coexist in one request — not every OpenRouter-routed
provider supports both at once reliably: phase one lets the model call tools
freely (capped at `MAX_TOOL_ROUNDS`, 6, in `review.sh`) with no
`response_format`; once it stops asking for tools (or hits the cap), one
final call — schema-constrained, no tools — turns everything it learned into
the structured verdict.

### Operating notes

- A malicious diff could try to prompt the model into calling `read_file` on
  something sensitive, but there's nothing sensitive to reach: the tools only
  read from the same repo's own git history, content already visible to
  anyone who could open a PR against it. `OR_KEY`/`GITHUB_TOKEN` are
  environment variables, never repo content, so no tool call can surface
  them.
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
  `z-ai/glm-5.3-flash` — chosen over kimi-k2.6 and kimi-k3 after running all
  three against 5 historical PRs with the production prompt/schema and
  checking every finding against the actual code: it matched kimi-k3's
  real-finding rate at roughly 1/16th the cost, and kimi-k2.6 produced an
  unparseable, budget-exhausting response on the largest diff) — OpenRouter
  slugs move. If reviews feel shallow, try `moonshotai/kimi-k3` before
  touching the prompt; if they're noisy, tighten
  `.github/scripts/review.sh`'s system prompt rather than switching
  models — false positives are mostly a prompt-threshold
  problem.
- Pilot on a repo's historical PRs and count false positives before trusting
  it on live work.
