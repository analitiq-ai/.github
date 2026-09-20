# .github

Org-wide shared GitHub Actions tooling for `analitiq-ai` repositories.

This repo hosts reusable workflows (`on: workflow_call`) and the scripts they
depend on, so CI logic shared across repos is defined once and referenced
from a thin caller workflow in each consuming repo, rather than copy-pasted.

## Contents

- `.github/workflows/ai-review.yml` — reusable workflow: an AI-generated code
  review posted as inline PR comments, triggered by a `/review` comment.
- `.github/workflows/pr-gate.yml` — reusable workflow: posts the
  `codex-review` and `internal-review` commit statuses on a PR's head, so a
  ruleset can require them. Rules in `.github/scripts/pr-gate.js`, tests in
  `tests/` (`node --test`).

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


## `pr-gate.yml`

Posts two commit statuses on the head of every open PR. Both are bound to the
commit they name, so a push voids them without anyone revoking anything.

| Status | `success` when | Otherwise |
|---|---|---|
| `codex-review` | Codex's newest verdict on the head commit is clean: its clean template ("Codex Review: Didn't find any major issues") with no findings preamble, or a [👍 tied to the head](#the-codex-thumbs-up) — or no verdict is on the head and the [credit waiver](#the-codex-credit-waiver) applies | `pending` |
| `internal-review` | a comment from `Analitiq-Bot` carries the attestation marker and names the head commit | `pending` |

A crash in the gate posts `error` on both, which still blocks a merge.

### The internal-review attestation

Posted by the agent once the internal review pass comes back clean on the
exact commit being merged:

```
<!-- analitiq-internal-review -->
Internal review clean.
Reviewed commit: `<full head sha>`
```

The gate can verify who posted it and which commit it names — not that the
review happened. It is a reminder with a SHA on it, not proof.

### The Codex credit waiver

When the account is out of review credits, Codex answers a review request with
"Codex usage limits have been reached for code reviews…" instead of a review.
Rather than block every PR until credits return, that answer waives the
requirement:

- only when **no** verdict names the head — a verdict for the head, clean or
  not, always outranks a waiver;
- only when the **whole comment** is exactly that message. The comment names
  no commit, so anything looser would let anyone who can get Codex to echo the
  sentence, or open a reply with it, waive the review;
- only when the comment was created **after the head commit was pushed**. An
  older answer says nothing about this commit: credits may have returned in
  between, and then Codex owes it a real review. Creation time, not edit time,
  so an edit cannot refresh an old comment;
- only while Codex shows **no 👀** on the PR description: a review is
  running, and its answer, a verdict or a fresh out-of-credits reply, is
  minutes away. A 👍 marks a review that has ended, so it does not suspend
  the waiver.

The push is dated by the commit's earliest check suite, which GitHub opens for
each installed app the moment a commit arrives. It is server-side (commit dates
are set by the author) and any run can read it, so the outcome does not depend
on which run got to the head first, or on one having crashed. A head with no
check suite is never waived.

If the head was pushed after Codex's last out-of-credits answer and credits are
still out, comment `@codex review`: Codex repeats the answer, now dated after
the push.

The status reads `WAIVED: Codex is out of credits; <sha> was not reviewed`, so
a skipped review is never mistaken for a passed one.

If Codex says nothing at all, nothing is waived.

### The Codex thumbs-up

Codex also reviews a PR unasked: when it is opened ready for review, and each
time it is marked ready. A clean review of that kind gets no comment, only a 👍
on the PR description, which Codex swaps for 👀 while a review runs. The 👍
names no commit, so it counts as a clean verdict, ranked at the time it was
given, only when no review that could have earned it read another commit:

- the head **arrived before the PR was first ready for review**. That is its
  opening, or, for a PR opened as a draft, the first time it was marked ready.
  The head arrived when it was first pushed (dated as for the waiver), unless
  the branch was force-pushed since: the last such force-push is when it
  arrived if it moved the branch to the head, and if it moved it to another
  commit, nothing dates the head's return and no 👍 counts;
- the 👍 came **after a ready request with no Codex verdict naming another
  commit** at or after it: that is a review requested by `@codex review` still
  finishing, and its 👍 looks the same. A later ready request ties the 👍
  again;
- Codex shows **no 👀** on the description, so no review is still running.

A tie in time counts against the 👍. So the 👍 counts on a PR opened as a
draft and marked ready once its commits are in, including after later
re-readies with no push in between. Once the head moves after the PR was first
ready, only `@codex review` gets a verdict: Codex answers it with one naming
the commit.

A counted 👍 reads `Codex found no major issues in <sha> (thumbs-up on the
PR)`, so it is never mistaken for a verdict naming the commit. A status
description spells the reaction out because the API rejects a description
carrying a character outside the BMP, which is what the reaction is.

A reaction triggers no workflow, so nothing re-runs the gate when the 👍
arrives; the next event or scheduled sweep would. To have it counted now, send
the consuming repo a `repository_dispatch`, which sweeps every open PR. Callers
do not filter on its event type, so no type has to be kept in step across
repos:

```bash
gh api repos/<owner>/<repo>/dispatches -f event_type=pr-gate
```

### While no verdict names the head

Unless the waiver applies, `codex-review` is pending, with the first
description that applies:

| When | Description |
|---|---|
| Codex shows 👀 | `Codex is reviewing; waiting for its verdict on <sha>` |
| a Codex 👍, but the push cannot be dated | `Codex's thumbs-up is not counted: <sha> has no check suite to date its push` |
| any other Codex 👍 | `Codex's thumbs-up is not tied to <sha>; comment @codex review` |
| an out-of-credits answer, but the push cannot be dated | `Codex is out of credits; <sha> has no check suite to date its push, so it is not waived` |
| an out-of-credits answer older than the push | `Codex's out-of-credits answer predates <sha>; comment @codex review` |
| any other answer from Codex | `No clean Codex verdict for <sha> yet` |
| no answer from Codex | `Waiting for a Codex review of <sha>` |

Whenever Codex answered, the run log also notes that no verdict names the head.

### What is deliberately not honored

- **A 👍 after the head moved on a PR that was ready for review**, whatever
  requests follow. Codex reviews some pushes to a ready PR unasked but not
  all, so a 👍 after one can be an older review finishing.
- **An `@codex review` comment as a request a 👍 answers.** Codex answers it
  with a verdict naming the commit, which counts on its own.
- **A commit prefix under 10 hex digits**, in either status. Ten is what Codex
  emits; accepting fewer would make it cheaper to craft a commit whose SHA
  collides with a stale verdict's prefix after a force-push.

### Wiring it into a consumer repo

```yaml
name: pr-gate

# Only events that run this file from the default branch. Never add
# pull_request_review or workflow_dispatch: a review event executes the
# workflow file from the PR merge ref, and a manual dispatch runs whichever ref
# is selected, so either lets a PR that edits this file post its own success.
# The reusable workflow refuses any other event. Verdicts delivered as PR
# reviews are picked up by the sweep, which a repository_dispatch runs on
# demand, e.g. once Codex gives its 👍.
on:
  pull_request_target:
    types: [opened, reopened, synchronize, ready_for_review]
  issue_comment:
    types: [created, edited, deleted]
  repository_dispatch:
  schedule:
    - cron: "*/15 * * * *"

permissions:
  contents: read
  statuses: write
  checks: read
  pull-requests: read
  issues: read

jobs:
  gate:
    # Comment events fire for every author; only these two can change a status.
    if: >-
      github.event_name != 'issue_comment' ||
      (github.event.issue.pull_request &&
       (github.event.comment.user.login == 'chatgpt-codex-connector[bot]' ||
        github.event.comment.user.login == 'Analitiq-Bot'))
    uses: analitiq-ai/.github/.github/workflows/pr-gate.yml@main
```

The `if:` is a cost gate, not a security boundary: a run only re-reads the PR
and re-derives both statuses, whoever triggered it.

Then require `codex-review` and `internal-review` in the branch ruleset.

The gate script is always fetched from this repo's `main`, whatever ref the
caller's `uses:` names, so a rule change reaches every consumer without each
bumping a pin. Pinning `uses:` to a SHA pins the workflow file, not the rules.

### Limits

- **A commit status is not proof of origin.** Anyone who can push a branch to
  the consuming repo can add a workflow of their own that posts `codex-review`
  with a write token. The gate stops mistakes and stale verdicts, not a
  collaborator acting in bad faith; forks cannot do this.
- **The waiver trusts the shape of Codex's message.** A reply in which Codex is
  talked into reproducing the entire usage-limit message, and nothing else,
  would waive the review. If Codex rewords the message, nothing is waived
  until the gate is updated.
- **A push is dated by when the commit first reached GitHub**, which is earlier
  than when it became this PR's head if it sat on another branch first. An
  out-of-credits answer from that interval then counts for it, and a 👍 can
  count although the PR was ready for review before the head reached it,
  unless the head arrived by force-push.
- **A review requested by comment could end in a bare 👍.** If one requested
  by `@codex review` on an older commit is still running when the PR is first
  marked ready, and Codex answers it with only a 👍 on the description, that
  👍 counts for the head. Codex normally answers that request with a verdict
  comment naming the commit, which voids the tie.
- **A 👀 Codex leaves behind holds `codex-review` pending**, waiver included.
  None has been seen left behind, including on PRs whose last Codex answer
  was out of credits.
- **Statuses belong to a commit, not a PR.** Two open PRs sharing a head SHA
  overwrite each other's statuses.
- **A stale `success` is revoked by the next event or sweep, not instantly.**
  A deleted attestation, a dismissed review or a withdrawn 👍 takes effect
  then. The sweep runs outside the per-PR concurrency group and statuses are
  last-writer-wins; the gate re-reads before demoting, which narrows that race
  without closing it.
