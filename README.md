# .github

Org-wide shared GitHub Actions tooling for `analitiq-ai` repositories.

This repo hosts reusable workflows (`on: workflow_call`), composite actions,
and the scripts they depend on, so CI logic shared across repos is defined
once and referenced from a thin caller workflow in each consuming repo, rather
than copy-pasted.

## Contents

- `.github/workflows/ai-review.yml` — reusable workflow: an AI-generated code
  review posted as inline PR comments, triggered by a `/review` comment.
- `.github/actions/pr-gate` — composite action: posts the `codex-review` and
  `internal-review` check runs on a PR's head, signed by the `analitiq-pr-gate`
  GitHub App, so a ruleset can require them. Rules in
  `.github/scripts/pr-gate.js`, tests in `tests/` (`node --test`).

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


## `pr-gate.yml` and the `pr-gate` action

Posts two check runs on the head of every open PR, signed by the
`analitiq-pr-gate` GitHub App. Both are bound to the commit they name, so a
push voids them without anyone revoking anything, and a consumer trusts a run
only when its `app.slug` is `analitiq-pr-gate` — a same-named run from any
other actor, App or workflow is not the gate's history and never suppresses a
fresh post.

| Check run | `success` (`completed`/`success`) when | Otherwise |
|---|---|---|
| `codex-review` | Codex's newest verdict on the head commit is clean: its clean template ("Codex Review: Didn't find any major issues") with no findings preamble, or a [👍 tied to the head](#the-codex-thumbs-up) — or no verdict is on the head and the [credit waiver](#the-codex-credit-waiver) applies | `in_progress`, titled with what is missing |
| `internal-review` | a comment from `Analitiq-Bot` carries the attestation marker and names the head commit | `in_progress`, titled with what is missing |

A [version-only release](#version-only-releases) passes both with
`completed`/`success` and needs neither review. A crash in the gate posts
`completed`/`failure` on both, titled with the error, which still blocks a
merge.

### Version-only releases

A PR whose diff, read for exactly its head, only moves its package's own
version up (and any pins of it with it) gets `success` on both check runs, and
both title `version-only release: OLD → NEW`. It qualifies only if all of these
hold:

- every file is modified, and GitHub returns its text patch (nothing added,
  removed or renamed, no binary or oversized file, no truncated comparison;
  a PR changing more than 300 files is never compared);
- every changed line is replaced in place by a line that differs only in
  whole version tokens, each moved `OLD → NEW`, the same pair across the PR. A
  version token is `x.y.z`, optionally followed by a pre-release suffix
  `a`/`alpha`/`b`/`beta`/`rc`/`dev` plus a number (`rc26`, `-beta1`);
- a changed `pyproject.toml` declares `OLD` at the merge base and `NEW` at the
  head as its own version (`version` under `[project]` or `[tool.poetry]`), or a
  changed `package.json` does as its top-level `"version"`;
- `NEW` is greater than `OLD`. Two pre-releases under different labels
  (`a1 → rc1`) do not compare, so they do not qualify.

A dependency, action or image pin never qualifies on its own, and neither does
a downgrade. If a request this check makes fails, the PR is gated by its
reviews as usual and the run logs a warning. CI and every other required check
still run. Any push re-evaluates the head.

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

The run titles `WAIVED: Codex is out of credits; <sha> was not reviewed`, so
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

A counted 👍 titles `Codex found no major issues in <sha> (thumbs-up on the
PR)`, so it is never mistaken for a verdict naming the commit. The title spells
the reaction out in words rather than embedding the emoji itself, so it reads
the same wherever a check run's title is rendered.

A reaction triggers no workflow, so nothing re-runs the gate when the 👍
arrives; the next event or scheduled sweep would. To have it counted now, send
the consuming repo a `repository_dispatch`, which sweeps every open PR. Callers
do not filter on its event type, so no type has to be kept in step across
repos:

```bash
gh api repos/<owner>/<repo>/dispatches -f event_type=pr-gate
```

### While no verdict names the head

Unless the waiver applies, `codex-review` is `in_progress`, titled with the
first line that applies:

| When | Title |
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
- **A commit prefix under 10 hex digits**, in either check run. Ten is what Codex
  emits; accepting fewer would make it cheaper to craft a commit whose SHA
  collides with a stale verdict's prefix after a force-push.

### Wiring it into a consumer repo

The App key must be readable only by a job whose workflow file comes from the
default branch. Only an environment with a branch policy gives that, and only
a job in the key's own repo can declare that environment and read its secret
without `secrets: inherit`. So the caller repo owns the job that mints the
token; the shared `pr-gate` action receives it and nothing else.

```yaml
on:
  pull_request_target:
    types: [opened, reopened, synchronize, ready_for_review]
  issue_comment:
    types: [created, edited, deleted]
  repository_dispatch:
  schedule:
    - cron: "*/15 * * * *"

permissions: {}

jobs:
  gate:
    if: >-
      github.event_name != 'issue_comment' ||
      (github.event.issue.pull_request &&
       (github.event.comment.user.login == 'chatgpt-codex-connector[bot]' ||
        github.event.comment.user.login == 'Analitiq-Bot'))
    runs-on: ubuntu-latest
    environment:
      name: pr-gate
      deployment: false
    concurrency:
      group: pr-gate-${{ github.event.pull_request.number || github.event.issue.number || 'sweep' }}
    steps:
      - id: token
        uses: actions/create-github-app-token@<full SHA> # vX.Y.Z
        with:
          client-id: ${{ vars.PR_GATE_CLIENT_ID }}
          private-key: ${{ secrets.PR_GATE_APP_KEY }}
          permission-checks: write
          permission-pull-requests: read
          permission-issues: read
          permission-contents: read
      - uses: analitiq-ai/.github/.github/actions/pr-gate@<full SHA>
        with:
          token: ${{ steps.token.outputs.token }}
```

- The job's triggers are `pull_request_target`, `issue_comment`, `schedule` and
  `repository_dispatch`. Each runs the workflow file from the default branch.
  `pull_request`, `push` and `workflow_dispatch` would run a branch's copy, and
  the environment's branch policy refuses those; `run()` refuses them too, so a
  caller wired to the wrong trigger fails its first run.
- `ready_for_review` re-runs the gate when a draft is marked ready, which is
  when Codex reviews unasked.
- The `if:` is a cost gate, not a security boundary: a run only re-reads the
  PR, so a comment from anyone else could change nothing, but it would start a
  runner and mint a token.
- `environment.deployment: false` means no "deployed" entries on PRs; the
  branch policy still applies.
- `permissions: {}`: `GITHUB_TOKEN` gets nothing, and every API call the gate
  makes uses the App token instead.
- The `permission-*` list above is exactly what `pr-gate.js` calls: checks
  write; pull-requests, issues and contents read.
- There is no `actions/checkout`. The action is fetched by the runner, and PR
  code is never on disk.

Then require `codex-review` and `internal-review` in the branch ruleset, each
with `integration_id` set to the App's id (the id is not secret; it lives only
in rulesets, never in a workflow).

### Per-repo setup

- Environment `pr-gate`:
  - deployment branches: `main` only;
  - secret `PR_GATE_APP_KEY`;
  - variable `PR_GATE_CLIENT_ID`.
- App installation: add the repo under "Only select repositories".
- `CODEOWNERS`: `/.github/ @<owner>`. Ruleset: require code-owner review. This
  stops a workflow that names the `pr-gate` environment from reaching `main`
  without the owner.

### Key rotation

Generate a second key, update `PR_GATE_APP_KEY` in every repo's environment,
confirm one gate run per repo, then delete the old key in the App settings.

### Limits

- **A check run is only as trustworthy as the App token that posted it.**
  `newestRun` trusts a run only when its `app.slug` is `analitiq-pr-gate`, so a
  collaborator's own workflow cannot forge one under that name; it can still
  post a check run under a different name, which a ruleset simply would not
  require.
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
- **A 👀 Codex leaves behind holds `codex-review` in progress**, waiver
  included. None has been seen left behind, including on PRs whose last Codex
  answer was out of credits.
- **Check runs belong to a commit, not a PR.** Two open PRs sharing a head SHA
  share each other's check runs.
- **A stale `success` is revoked by the next event or sweep, not instantly.**
  A deleted attestation, a dismissed review or a withdrawn 👍 takes effect
  then. The sweep runs outside the per-PR concurrency group and runs are
  last-writer-wins; the gate re-reads before demoting, which narrows that race
  without closing it.
