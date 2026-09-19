'use strict';

// Turns two facts no GitHub check can observe on its own into commit statuses
// on a PR's head, so a ruleset can require them:
//
//   codex-review     Codex reviewed THIS commit and found nothing major.
//   internal-review  Analitiq-Bot attested a clean internal review of THIS
//                    commit (verifiable only as far as author + SHA).
//
// Both are bound to a SHA for the same reason: a push moves the head, and a
// verdict for the old head must stop counting without anyone remembering to
// revoke it.
//
// Codex's 👍 names no commit, so it counts only when every review that could
// have earned it read the head (see codexReactionAnswer).

const CODEX = 'chatgpt-codex-connector[bot]';
const CODEX_CONTEXT = 'codex-review';
const THUMBS_UP = '+1';
const REVIEWING = 'eyes';

// Line-anchored to Codex's clean-verdict template. The findings preamble
// rejects a body outright, because a findings review can legitimately open a
// line with the clean phrase ("Codex Review: Didn't find any major issues
// elsewhere.").
const CLEAN = /^Codex Review: Didn.t find any major issues/im;
const FINDINGS = /Here are some automated review suggestions/i;

// Codex renders the commit marker bolded or plain depending on surface. Ten hex
// digits because that is what Codex emits; anything shorter is rejected, which
// raises the cost of reusing a stale verdict through a crafted prefix collision
// after a force-push without eliminating it.
const CODEX_REVIEWED_COMMIT = /\*{0,2}Reviewed commit:\*{0,2}\s*`([0-9a-f]{10,40})`/gi;

// What Codex posts, verbatim, instead of a review when the account is out of
// review credits. Compared for equality: the comment names no commit, so any
// looser match would let whoever can get Codex to echo or open a reply with
// the sentence waive the review. If Codex rewords it the waiver stops working,
// which fails closed.
const USAGE_LIMIT_MESSAGE =
  'Codex usage limits have been reached for code reviews. Please check with the admins of this repo to increase the limits by adding credits.\n' +
  'Credits must be used to enable repository wide code reviews.';

const ATTESTOR = 'Analitiq-Bot';
const INTERNAL_CONTEXT = 'internal-review';
const ATTESTATION_MARKER = '<!-- analitiq-internal-review -->';
// Looser quoting than Codex's marker: this one is typed by an agent through a
// shell, where backticks are the first thing to get mangled.
const ATTESTED_COMMIT = /\*{0,2}Reviewed commit:\*{0,2}\s*[`'"]?([0-9a-f]{10,40})/gi;

// GitHub rejects a longer status description.
const MAX_STATUS_DESCRIPTION = 140;

const short = (sha) => sha.slice(0, 10);

// `user` is null for a deleted account, which is nobody we trust.
const authoredBy = (item, login) => item.user?.login === login;

// A timestamp that does not parse must never reach a comparison: NaN compares
// false both ways, which silently reorders verdicts instead of failing.
function timestamp(value, what) {
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`${what} has no valid timestamp: ${JSON.stringify(value)}`);
  return at;
}

const namesHead = (body, pattern, head) =>
  [...body.matchAll(pattern)].some((match) => head.startsWith(match[1].toLowerCase()));

const codexReactions = (reactions, content) => reactions.filter((r) => authoredBy(r, CODEX) && r.content === content);

// Codex reviews a PR unasked when it is opened ready for review and each time
// it is marked ready. It was opened as a draft if its first transition marked
// it ready, or, with none, if it is a draft still.
function readyRequests({ events, openedAt, draft }) {
  if (typeof draft !== 'boolean') throw new Error(`pull request has no draft flag: ${JSON.stringify(draft)}`);
  const transitions = events
    .filter((e) => e.event === 'ready_for_review' || e.event === 'convert_to_draft')
    .map((e) => ({ readied: e.event === 'ready_for_review', at: timestamp(e.created_at, `${e.event} event`) }))
    .sort((a, b) => a.at - b.at);
  const openedAsDraft = transitions.length > 0 ? transitions[0].readied : draft;
  const readied = transitions.filter((t) => t.readied).map((t) => t.at);
  return openedAsDraft ? readied : [timestamp(openedAt, 'pull request'), ...readied];
}

// The head's first push is dated by its earliest check suite. The last
// force-push since then decides: one to the head is when it arrived; after one
// to another commit, the head came back by a push no event records.
function headArrivedAt({ events, head, headPushedAt }) {
  const moves = events
    .filter((e) => e.event === 'head_ref_force_pushed')
    .map((e) => ({ to: e.commit_id, at: timestamp(e.created_at, 'head_ref_force_pushed event') }))
    .filter((move) => move.at >= headPushedAt)
    .sort((a, b) => a.at - b.at);
  const last = moves[moves.length - 1];
  if (last === undefined) return headPushedAt;
  return last.to === head ? last.at : null;
}

// Codex answers a clean review it made unasked with nothing but a 👍 on the
// description, and shows 👀 there while a review runs. The 👍 names no commit,
// so it counts, as a clean verdict at its own time, only when no review that
// could have earned it read another commit:
//   - the head arrived before the first ready request: until then Codex
//     reviews nothing unasked, and after it the head never moved;
//   - it came after a ready request with no Codex verdict on another commit
//     since: that is a review requested by comment still finishing, and its 👍
//     looks the same.
// `@codex review` comments are not such requests: Codex answers them with a
// verdict naming the commit, which counts on its own.
// Returns that verdict, or why there is none; null when Codex shows neither.
function codexReactionAnswer({ responses, reactions, events, openedAt, draft, head, headPushedAt }) {
  if (codexReactions(reactions, REVIEWING).length > 0) {
    return { pending: `Codex is reviewing; waiting for its verdict on ${short(head)}`, reviewing: true };
  }
  // GitHub keeps one reaction per user and content.
  const [thumbsUp] = codexReactions(reactions, THUMBS_UP);
  if (thumbsUp === undefined) return null;
  if (headPushedAt === null) {
    return { pending: `Codex's 👍 is not counted: ${short(head)} has no check suite to date its push` };
  }

  const at = timestamp(thumbsUp.created_at, 'Codex reaction');
  const requests = readyRequests({ events, openedAt, draft });
  const arrived = headArrivedAt({ events, head, headPushedAt });
  const voids = responses
    .filter((r) => r.body.search(CODEX_REVIEWED_COMMIT) !== -1 && !namesHead(r.body, CODEX_REVIEWED_COMMIT, head))
    .map((r) => r.created);
  // Every tie is ordered against the 👍.
  const tied =
    arrived !== null &&
    requests.every((requested) => arrived < requested) &&
    requests.some((requested) => requested < at && !voids.some((voided) => voided >= requested));
  return tied
    ? { verdict: { clean: true, at, byThumbsUp: true } }
    : { pending: `Codex's 👍 is not tied to ${short(head)}; comment @codex review` };
}

// Codex's out-of-credits answer names no commit, so its age against the push
// is the only thing tying it to this head: an answer older than the push says
// nothing about whether credits have returned since. Returns whether it waives
// the head, or why not; null when Codex never gave it.
function outOfCreditsAnswer({ codexComments, head, headPushedAt }) {
  const answers = codexComments.filter((c) => (c.body || '').trim() === USAGE_LIMIT_MESSAGE);
  if (answers.length === 0) return null;
  if (headPushedAt === null) {
    return { pending: `Codex is out of credits; ${short(head)} has no check suite to date its push, so it is not waived` };
  }
  // Dated by creation: an edit must not be able to make an old answer recent.
  if (answers.some((c) => timestamp(c.created_at, 'Codex comment') > headPushedAt)) return { waives: true };
  return { pending: `Codex's out-of-credits answer predates ${short(head)}; comment @codex review` };
}

// headPushedAt: when the head commit reached GitHub, in epoch milliseconds, or
//   null when that is unknown.
// reactions: those on the PR description. events: the PR's issue events.
// openedAt: when the PR was opened. draft: whether it is a draft now.
function codexStatus({ comments, reviews, reactions, events, openedAt, draft, head, headPushedAt }) {
  const codexComments = comments.filter((c) => authoredBy(c, CODEX));

  const responses = codexComments
    .map((c) => ({
      body: c.body || '',
      created: timestamp(c.created_at, 'Codex comment'),
      edited: timestamp(c.updated_at, 'Codex comment'),
    }))
    .concat(
      reviews
        // A dismissed review was explicitly invalidated by a maintainer.
        .filter((r) => authoredBy(r, CODEX) && r.state !== 'DISMISSED')
        .map((r) => {
          // Reviews carry no edit time.
          const submitted = timestamp(r.submitted_at, 'Codex review');
          return { body: r.body || '', created: submitted, edited: submitted };
        }),
    );
  const reactionAnswer = codexReactionAnswer({ responses, reactions, events, openedAt, draft, head, headPushedAt });

  // The newest verdict on this exact commit decides. A clean verdict ranks at
  // its creation and a findings verdict at its last edit, so an edit can void
  // an approval but can never revive one that a later review overruled.
  const verdicts = responses
    .filter((r) => namesHead(r.body, CODEX_REVIEWED_COMMIT, head))
    .map((r) => {
      const clean = CLEAN.test(r.body) && !FINDINGS.test(r.body);
      return { clean, at: clean ? r.created : Math.max(r.created, r.edited) };
    })
    .concat(reactionAnswer?.verdict ?? [])
    // At the same instant the non-clean verdict sorts last, and so decides.
    .sort((a, b) => a.at - b.at || Number(b.clean) - Number(a.clean));
  const latest = verdicts[verdicts.length - 1];

  if (latest !== undefined) {
    if (latest.clean) {
      const found = `Codex found no major issues in ${short(head)}`;
      return { state: 'success', description: latest.byThumbsUp ? `${found} (👍 on the PR)` : found };
    }
    return {
      state: 'pending',
      description: `No clean Codex verdict for ${short(head)} yet`,
      notice: `Codex's newest verdict for ${short(head)} is not its clean template`,
    };
  }

  // The waiver only fills the absence of a verdict, and only while Codex runs
  // no review: one running shows the credits are back.
  const credits = outOfCreditsAnswer({ codexComments, head, headPushedAt });
  if (credits?.waives && !reactionAnswer?.reviewing) {
    return { state: 'success', description: `WAIVED: Codex is out of credits; ${short(head)} was not reviewed` };
  }
  const description =
    reactionAnswer?.pending ??
    credits?.pending ??
    (responses.length > 0
      ? `No clean Codex verdict for ${short(head)} yet`
      : `Waiting for a Codex review of ${short(head)}`);
  return responses.length > 0
    ? {
        state: 'pending',
        description,
        // If Codex rewords its template, this is the only trace that it
        // answered at all.
        notice: `Codex responded, but no verdict names ${short(head)}`,
      }
    : { state: 'pending', description };
}

function internalReviewStatus({ comments, head }) {
  const attestations = comments.filter(
    (c) => authoredBy(c, ATTESTOR) && (c.body || '').includes(ATTESTATION_MARKER),
  );
  if (attestations.some((c) => namesHead(c.body, ATTESTED_COMMIT, head))) {
    return { state: 'success', description: `Internal review clean on ${short(head)}` };
  }
  return attestations.length > 0
    ? {
        state: 'pending',
        description: `An attestation exists, but none names ${short(head)}`,
        // Usually an attestation for an older head; sometimes one whose SHA
        // the posting shell swallowed along with its backticks.
        notice: `${attestations.length} attestation comment(s) found, none naming ${short(head)}`,
      }
    : { state: 'pending', description: `Waiting for an internal review of ${short(head)}` };
}

// Newest first, which is the order the API returns and `history` keeps.
const newest = (history, context) => history.find((s) => s.context === context);

async function post({ github, core, owner, repo, pr, history, context, status }) {
  const current = newest(history, context);
  // GitHub keeps at most 1000 statuses per commit and context, after which it
  // refuses new ones; a sweep re-posting an unchanged status every run would
  // spend that in days and leave the gate unable to ever report again.
  if (current && current.state === status.state && current.description === status.description) {
    core.info(`PR #${pr.number} @ ${short(pr.head.sha)}: ${context} already ${status.state}`);
    return;
  }
  await github.rest.repos.createCommitStatus({
    owner,
    repo,
    sha: pr.head.sha,
    context,
    state: status.state,
    description: status.description,
    target_url: pr.html_url,
  });
  core.info(`PR #${pr.number} @ ${short(pr.head.sha)}: ${context} -> ${status.state} (${status.description})`);
}

async function readStatuses({ github, owner, repo, pr }) {
  const head = pr.head.sha;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pr.number,
    per_page: 100,
  });
  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const reactions = await github.paginate(github.rest.reactions.listForIssue, {
    owner,
    repo,
    issue_number: pr.number,
    per_page: 100,
  });
  const events = await github.paginate(github.rest.issues.listEvents, {
    owner,
    repo,
    issue_number: pr.number,
    per_page: 100,
  });

  // GitHub opens a check suite per installed app the moment a commit is
  // pushed. It is the one server-side record of that moment every run can
  // read: commit dates are set by the author, and anything the gate records
  // itself is lost to a crashed, cancelled or late first run.
  const suites = await github.paginate(github.rest.checks.listSuitesForRef, {
    owner,
    repo,
    ref: head,
    per_page: 100,
  });
  const pushTimes = suites.map((s) => timestamp(s.created_at, `check suite ${s.id}`));
  const headPushedAt = pushTimes.length > 0 ? Math.min(...pushTimes) : null;

  return {
    [CODEX_CONTEXT]: codexStatus({
      comments,
      reviews,
      reactions,
      events,
      openedAt: pr.created_at,
      draft: pr.draft,
      head,
      headPushedAt,
    }),
    [INTERNAL_CONTEXT]: internalReviewStatus({ comments, head }),
  };
}

async function evaluateHead({ github, core, owner, repo, pr, history }) {
  let wanted = await readStatuses({ github, owner, repo, pr });

  // Statuses are last-writer-wins, and the sweep runs outside the per-PR
  // concurrency group. A run working from a snapshot taken before a verdict
  // landed would overwrite a newer success (or race past it on a brand-new
  // head), so a demotion or a first pending is re-derived from a fresh read
  // right before posting. That narrows the race; it does not close it.
  const aboutToDemote = Object.entries(wanted).some(([context, status]) => {
    const current = newest(history, context);
    return status.state !== 'success' && (!current || current.state === 'success');
  });
  if (aboutToDemote) {
    wanted = await readStatuses({ github, owner, repo, pr });
  }

  for (const [context, status] of Object.entries(wanted)) {
    if (status.notice) core.notice(`PR #${pr.number}: ${status.notice}`);
    await post({ github, core, owner, repo, pr, history, context, status });
  }
}

async function evaluate({ github, core, owner, repo, prNumber }) {
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (pr.state !== 'open') {
    core.info(`PR #${prNumber} is ${pr.state}; nothing to gate`);
    return;
  }

  let history = [];
  try {
    history = await github.paginate(github.rest.repos.listCommitStatusesForRef, {
      owner,
      repo,
      ref: pr.head.sha,
      per_page: 100,
    });
    await evaluateHead({ github, core, owner, repo, pr, history });
  } catch (error) {
    // Surface the crash on the PR itself: a run that dies here is otherwise
    // visible only in the Actions tab, and the author would read the stuck
    // gate as "the reviewer is slow". The error state still blocks merge. Both
    // contexts: they are derived together, so after a failure neither is known
    // to be current.
    const status = { state: 'error', description: `pr-gate failed: ${error}`.slice(0, MAX_STATUS_DESCRIPTION) };
    for (const context of [CODEX_CONTEXT, INTERNAL_CONTEXT]) {
      try {
        await post({ github, core, owner, repo, pr, history, context, status });
      } catch (statusError) {
        core.error(`PR #${prNumber}: could not post ${context} error status: ${statusError.stack || statusError}`);
      }
    }
    throw error;
  }
}

// Entry point for actions/github-script. The schedule's sweep is the retry net
// for event runs that failed or were never delivered, and the only trigger
// guaranteed to follow a verdict delivered as a PR review, since review events
// must never trigger this (see pr-gate.yml). A repository_dispatch sweeps too:
// a reaction triggers nothing, so whoever sees Codex's 👍 dispatches one rather
// than wait for the next scheduled sweep.
async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  const { pull_request: pullRequest, issue } = context.payload;

  if (pullRequest) {
    await evaluate({ github, core, owner, repo, prNumber: pullRequest.number });
    return;
  }
  if (issue) {
    if (issue.pull_request) {
      await evaluate({ github, core, owner, repo, prNumber: issue.number });
    } else {
      core.info(`#${issue.number} is an issue, not a PR; nothing to gate`);
    }
    return;
  }

  const open = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
  core.info(`sweep: ${open.length} open PR(s)`);
  const failures = [];
  for (const pr of open) {
    try {
      await evaluate({ github, core, owner, repo, prNumber: pr.number });
    } catch (error) {
      // One broken PR must not starve the rest.
      failures.push(`#${pr.number}: ${error}`);
      core.error(`PR #${pr.number}: ${error.stack || error}`);
    }
  }
  if (failures.length > 0) {
    core.setFailed(`sweep failed for ${failures.length} PR(s): ${failures.join('; ')}`);
  }
}

module.exports = { codexStatus, internalReviewStatus, run };
