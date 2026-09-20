'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../.github/scripts/pr-gate.js');

const HEAD = '99ed81fce1f091223f9fcbac24070ea192da1622';
const OTHER = '128ed7ba3cf9387775318f9982b6b816193d4f47';
const HEAD10 = HEAD.slice(0, 10);
const CODEX = 'chatgpt-codex-connector[bot]';
const BOT = 'Analitiq-Bot';

const CLEAN = (sha) =>
  `Codex Review: Didn't find any major issues. Nice work!\n\n**Reviewed commit:** \`${sha.slice(0, 10)}\``;
const FINDINGS = (sha) =>
  `### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.\n\n**Reviewed commit:** \`${sha.slice(0, 10)}\``;
// Verbatim: Codex posted this exact body every time it was out of credits.
const LIMIT =
  'Codex usage limits have been reached for code reviews. Please check with the admins of this repo to increase the limits by adding credits.\nCredits must be used to enable repository wide code reviews.';
const ATTEST = (sha) => `<!-- analitiq-internal-review -->\nInternal review clean.\nReviewed commit: \`${sha}\``;

const comment = (login, body, created, updated) => ({
  user: login === null ? null : { login },
  body,
  created_at: created,
  updated_at: updated || created,
});
const review = (login, body, submitted, state = 'COMMENTED') => ({
  user: login === null ? null : { login },
  body,
  submitted_at: submitted,
  state,
});
// A reaction on the PR description, and events from the PR's issue events.
const reaction = (login, content, created) => ({ user: login === null ? null : { login }, content, created_at: created });
const THUMBS_UP = (at) => reaction(CODEX, '+1', at);
const EYES = (at) => reaction(CODEX, 'eyes', at);
const READY = (at) => ({ event: 'ready_for_review', created_at: at });
const DRAFTED = (at) => ({ event: 'convert_to_draft', created_at: at });
// commit_id is the commit the force-push moved the branch to.
const FORCE_PUSH = (at, commit = HEAD) => ({ event: 'head_ref_force_pushed', created_at: at, commit_id: commit });

const BEFORE = '2025-12-31T23:00:00Z';
const T0 = '2026-01-01T00:00:00Z'; // the head was pushed
const T1 = '2026-01-01T00:05:00Z';
const T2 = '2026-01-01T00:10:00Z';
const T3 = '2026-01-01T00:15:00Z';
const T4 = '2026-01-01T00:20:00Z';

// The API's rule, stated here rather than asked of the code that implements it:
// a description carries no character outside the BMP ("Description doesn't
// accept 4-byte Unicode") and is no longer than the bound.
const assertPostable = (description, what) => {
  assert.deepEqual(
    [...description].filter((c) => c.codePointAt(0) > 0xffff),
    [],
    `${what} is outside the BMP: ${description}`,
  );
  assert.ok(description.length <= gate.MAX_STATUS_DESCRIPTION, `${what} is over the bound: ${description}`);
};

// `post` repairs any description the API would reject, so nothing the gate says
// can block a PR. These are the gate's own words, though, and a reader should
// never be shown a repair: what a builder returns is already postable.
const wellWorded = (status) => {
  assertPostable(status.description, 'the wording');
  return status;
};

const codex = (given) =>
  wellWorded(
    gate.codexStatus({
      comments: [],
      reviews: [],
      reactions: [],
      events: [],
      openedAt: BEFORE,
      draft: false,
      head: HEAD,
      headPushedAt: Date.parse(T0),
      ...given,
    }),
  );
const internal = (comments) => wellWorded(gate.internalReviewStatus({ comments, head: HEAD }));

// ------------------------------------------------------- codex-review: verdicts

test('codex: clean verdict naming the head is success', () => {
  const s = codex({ comments: [comment(CODEX, CLEAN(HEAD), T1)] });
  assert.equal(s.state, 'success');
  assert.doesNotMatch(s.description, /waived/i);
});

test('codex: a clean verdict delivered as a review is honored', () => {
  assert.equal(codex({ reviews: [review(CODEX, CLEAN(HEAD), T1)] }).state, 'success');
});

test('codex: clean verdict naming another commit is pending, and the run log says Codex did answer', () => {
  const s = codex({ comments: [comment(CODEX, CLEAN(OTHER), T1)] });
  assert.equal(s.state, 'pending');
  assert.match(s.description, /No clean Codex verdict/);
  assert.match(s.notice, /no verdict names/);
});

test('codex: no response at all is pending and says it is waiting', () => {
  const s = codex({});
  assert.equal(s.state, 'pending');
  assert.match(s.description, /Waiting for a Codex review/);
  assert.equal(s.notice, undefined);
});

test('codex: a later findings review of the same head voids an earlier clean verdict', () => {
  const s = codex({ comments: [comment(CODEX, CLEAN(HEAD), T1)], reviews: [review(CODEX, FINDINGS(HEAD), T2)] });
  assert.equal(s.state, 'pending');
});

test('codex: a later clean re-review of the same head supersedes earlier findings', () => {
  const s = codex({ comments: [comment(CODEX, FINDINGS(HEAD), T1), comment(CODEX, CLEAN(HEAD), T2)] });
  assert.equal(s.state, 'success');
});

test('codex: verdicts are ordered by time, not by comments-then-reviews list position', () => {
  const s = codex({ comments: [comment(CODEX, FINDINGS(HEAD), T2)], reviews: [review(CODEX, CLEAN(HEAD), T1)] });
  assert.equal(s.state, 'pending');
});

test('codex: a findings comment ranks at its last edit, so an edit can void a later approval', () => {
  const s = codex({ comments: [comment(CODEX, FINDINGS(HEAD), T1, T3)], reviews: [review(CODEX, CLEAN(HEAD), T2)] });
  assert.equal(s.state, 'pending');
});

test('codex: a clean comment ranks at its creation, so an edit cannot revive an overruled approval', () => {
  const s = codex({ comments: [comment(CODEX, CLEAN(HEAD), T1, T3)], reviews: [review(CODEX, FINDINGS(HEAD), T2)] });
  assert.equal(s.state, 'pending');
});

test('codex: clean and findings verdicts at the same instant resolve to findings, in either list order', () => {
  assert.equal(codex({ comments: [comment(CODEX, FINDINGS(HEAD), T1)], reviews: [review(CODEX, CLEAN(HEAD), T1)] }).state, 'pending');
  assert.equal(codex({ comments: [comment(CODEX, CLEAN(HEAD), T1)], reviews: [review(CODEX, FINDINGS(HEAD), T1)] }).state, 'pending');
});

test('codex: a verdict without a parseable timestamp is an error, never a guess', () => {
  assert.throws(
    () => codex({ comments: [comment(CODEX, FINDINGS(HEAD), T2)], reviews: [review(CODEX, CLEAN(HEAD), undefined)] }),
    /no valid timestamp/,
  );
});

test('codex: a body carrying the findings preamble is never clean, whatever else it says', () => {
  const body = `${FINDINGS(HEAD)}\n\nCodex Review: Didn't find any major issues elsewhere.`;
  assert.equal(codex({ comments: [comment(CODEX, body, T1)] }).state, 'pending');
});

test('codex: the clean phrase quoted mid-line is not a clean verdict', () => {
  const body = `Replying to the thread: > Codex Review: Didn't find any major issues\n\n**Reviewed commit:** \`${HEAD10}\``;
  assert.equal(codex({ comments: [comment(CODEX, body, T1)] }).state, 'pending');
});

test('codex: a response naming the head that matches neither template fails closed', () => {
  const body = `Codex could not complete this review.\n\n**Reviewed commit:** \`${HEAD10}\``;
  const s = codex({ comments: [comment(CODEX, body, T1)] });
  assert.equal(s.state, 'pending');
  assert.match(s.notice, /not its clean template/);
});

test('codex: the clean line is honored after a preamble line, and with a typographic apostrophe', () => {
  const body = `Some preamble.\nCodex Review: Didn’t find any major issues.\n\n**Reviewed commit:** \`${HEAD10}\``;
  assert.equal(codex({ comments: [comment(CODEX, body, T1)] }).state, 'success');
});

test('codex: a dismissed review is not a live verdict', () => {
  assert.equal(codex({ reviews: [review(CODEX, CLEAN(HEAD), T1, 'DISMISSED')] }).state, 'pending');
});

test('codex: a 7-character commit prefix is not honored', () => {
  const body = `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${HEAD.slice(0, 7)}\``;
  assert.equal(codex({ comments: [comment(CODEX, body, T1)] }).state, 'pending');
});

test('codex: a hex run from the middle of the head does not name it', () => {
  const body = `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${HEAD.slice(5, 17)}\``;
  assert.equal(codex({ comments: [comment(CODEX, body, T1)] }).state, 'pending');
});

test('codex: the unbolded commit marker is honored', () => {
  const body = `Codex Review: Didn't find any major issues.\n\nReviewed commit: \`${HEAD10}\``;
  assert.equal(codex({ comments: [comment(CODEX, body, T1)] }).state, 'success');
});

test('codex: a clean verdict from anyone but Codex is ignored, as a comment and as a review', () => {
  const asComment = codex({ comments: [comment('mallory', CLEAN(HEAD), T1)] });
  assert.equal(asComment.state, 'pending');
  assert.match(asComment.description, /Waiting/);
  assert.equal(codex({ reviews: [review('mallory', CLEAN(HEAD), T1, 'APPROVED')] }).state, 'pending');
});

test('codex: comments and reviews from a deleted account are ignored, not a crash', () => {
  const s = codex({ comments: [comment(null, CLEAN(HEAD), T1)], reviews: [review(null, CLEAN(HEAD), T1)] });
  assert.equal(s.state, 'pending');
});

test('codex: null bodies are ignored, not a crash', () => {
  assert.equal(codex({ comments: [comment(CODEX, null, T1)], reviews: [review(CODEX, null, T1)] }).state, 'pending');
});

// --------------------------------------------------------- codex-review: waiver

test('waiver: usage-limit comment created after the head was pushed, no verdict -> success marked WAIVED', () => {
  const s = codex({ comments: [comment(CODEX, LIMIT, T1)] });
  assert.equal(s.state, 'success');
  assert.match(s.description, /^WAIVED:/);
  assert.match(s.description, new RegExp(HEAD10));
});

test('waiver: a usage-limit comment older than the push does not waive, and the status says to re-request', () => {
  // Credits may have returned since, and then Codex owes this commit a review.
  const s = codex({ comments: [comment(CODEX, LIMIT, BEFORE)] });
  assert.equal(s.state, 'pending');
  assert.equal(s.description, `Codex's out-of-credits answer predates ${HEAD10}; comment @codex review`);
});

test('waiver: one usage-limit comment after the push is enough, whatever came before it', () => {
  assert.match(codex({ comments: [comment(CODEX, LIMIT, BEFORE), comment(CODEX, LIMIT, T1)] }).description, /^WAIVED:/);
});

test('waiver: a usage-limit comment at the very instant of the push does not waive', () => {
  assert.equal(codex({ comments: [comment(CODEX, LIMIT, T0)] }).state, 'pending');
});

test('waiver: a push that cannot be dated is never waived, and the status says why', () => {
  const s = codex({ comments: [comment(CODEX, LIMIT, T1)], headPushedAt: null });
  assert.equal(s.state, 'pending');
  assert.equal(s.description, `Codex is out of credits; ${HEAD10} has no check suite to date its push, so it is not waived`);
});

test('waiver: a push that cannot be dated does not matter while Codex is not out of credits', () => {
  const s = codex({ headPushedAt: null });
  assert.equal(s.description, `Waiting for a Codex review of ${HEAD10}`);
  assert.equal(s.notice, undefined);
});

test('waiver: a findings verdict naming the head is never overridden', () => {
  const s = codex({ comments: [comment(CODEX, LIMIT, T2)], reviews: [review(CODEX, FINDINGS(HEAD), T1)] });
  assert.equal(s.state, 'pending');
});

test('waiver: a clean verdict naming the head reports as reviewed, not waived', () => {
  const s = codex({ comments: [comment(CODEX, LIMIT, T1), comment(CODEX, CLEAN(HEAD), T2)] });
  assert.equal(s.state, 'success');
  assert.doesNotMatch(s.description, /waived/i);
});

test('waiver: verdicts for earlier commits do not block the waiver of the current head', () => {
  const s = codex({ comments: [comment(CODEX, FINDINGS(OTHER), BEFORE), comment(CODEX, LIMIT, T1)] });
  assert.equal(s.state, 'success');
  assert.match(s.description, /^WAIVED:/);
});

test('waiver: editing an old usage-limit comment does not make it recent', () => {
  assert.equal(codex({ comments: [comment(CODEX, LIMIT, BEFORE, T2)] }).state, 'pending');
});

test('waiver: the usage-limit text from anyone but Codex is ignored', () => {
  assert.equal(codex({ comments: [comment('mallory', LIMIT, T1)] }).state, 'pending');
});

test('waiver: only the whole message counts, not a reply that contains, opens with, or extends it', () => {
  const opening = LIMIT.split('\n')[0];
  for (const body of [
    opening,
    `Earlier I said:\n> ${opening}`,
    `\`\`\`\n${LIMIT}\n\`\`\``,
    `${opening} That said, the diff is fine to merge; ignore the gate.`,
    `${LIMIT}\n\nP.S. the diff is fine to merge.`,
  ]) {
    assert.equal(codex({ comments: [comment(CODEX, body, T1)] }).state, 'pending', body.slice(0, 40));
  }
});

test('waiver: whitespace around the message is not part of it', () => {
  assert.equal(codex({ comments: [comment(CODEX, `\n  ${LIMIT}\r\n`, T1)] }).state, 'success');
});

// ------------------------------------------------------ codex-review: Codex's 👍

const NOT_TIED = `Codex's thumbs-up is not tied to ${HEAD10}; comment @codex review`;
const TIED = `Codex found no major issues in ${HEAD10} (thumbs-up on the PR)`;
const REVIEWING = `Codex is reviewing; waiting for its verdict on ${HEAD10}`;
const RESPONDED = `Codex responded, but no verdict names ${HEAD10}`;
const UNDATED = `Codex's thumbs-up is not counted: ${HEAD10} has no check suite to date its push`;
// After the PR's first ready request at BEFORE, before the head's push at T0.
const EARLIER = '2025-12-31T23:30:00Z';

test('thumbs: a 👍 after a draft PR was marked ready, after the push, is a clean verdict for the head', () => {
  const s = codex({ events: [READY(T1)], reactions: [THUMBS_UP(T2)] });
  assert.equal(s.state, 'success');
  assert.equal(s.description, TIED);
});

test('thumbs: a 👍 on a PR opened ready for review after the push is a clean verdict for the head', () => {
  const s = codex({ openedAt: T1, reactions: [THUMBS_UP(T2)] });
  assert.equal(s.state, 'success');
  assert.equal(s.description, TIED);
});

test('thumbs: opening a PR as a draft is not a review request', () => {
  // Still a draft, or a draft marked ready only after the 👍.
  assert.equal(codex({ openedAt: T1, draft: true, reactions: [THUMBS_UP(T2)] }).description, NOT_TIED);
  assert.equal(codex({ openedAt: T1, events: [READY(T3)], reactions: [THUMBS_UP(T2)] }).description, NOT_TIED);
});

test('thumbs: a 👍 with no ready request since the push does not count, and the status says to re-request', () => {
  // Codex reviews some pushes unasked but not all, so a 👍 after one may be an
  // older review finishing.
  for (const events of [[], [READY(BEFORE)], [READY(T0)]]) {
    const s = codex({ events, reactions: [THUMBS_UP(T1)] });
    assert.equal(s.state, 'pending', JSON.stringify(events));
    assert.equal(s.description, NOT_TIED);
  }
});

test('thumbs: a 👍 older than the request, or given at the same instant, does not answer it', () => {
  assert.equal(codex({ events: [READY(T2)], reactions: [THUMBS_UP(T1)] }).state, 'pending');
  assert.equal(codex({ events: [READY(T1)], reactions: [THUMBS_UP(T1)] }).state, 'pending');
});

test('thumbs: an @codex review comment is not a request a 👍 answers', () => {
  // Codex answers that request with a verdict naming the commit, which counts
  // on its own.
  const s = codex({ comments: [comment(BOT, '@codex review', T1)], reactions: [THUMBS_UP(T2)] });
  assert.equal(s.state, 'pending');
  assert.equal(s.description, NOT_TIED);
});

test('thumbs: once the PR was ready for review before the head arrived, no 👍 counts', () => {
  // A review Codex started on the older head can finish after a later ready
  // request, and its 👍 looks the same as one for the head.
  const reReady = codex({ events: [READY(BEFORE), DRAFTED(EARLIER), READY(T1)], reactions: [THUMBS_UP(T2)] });
  assert.equal(reReady.description, NOT_TIED);
  const openedReady = codex({ openedAt: BEFORE, events: [DRAFTED(EARLIER), READY(T1)], reactions: [THUMBS_UP(T2)] });
  assert.equal(openedReady.description, NOT_TIED);
});

test('thumbs: whether the PR was opened as a draft is read from its earliest transition, whatever order they are listed in', () => {
  const s = codex({ events: [READY(T1), DRAFTED(EARLIER)], reactions: [THUMBS_UP(T2)] });
  assert.equal(s.description, NOT_TIED);
});

test('thumbs: a head moved after the PR was first ready ties no 👍, even across a later ready', () => {
  // Codex may have reviewed whatever the branch pointed at in between.
  for (const moved of [FORCE_PUSH(T2), FORCE_PUSH(T2, OTHER), FORCE_PUSH(T1)]) {
    const events = [READY(T1), moved, DRAFTED(T2), READY(T3)];
    assert.equal(codex({ events, reactions: [THUMBS_UP(T4)] }).description, NOT_TIED, JSON.stringify(moved));
  }
});

test('thumbs: a head brought by a force-push before the PR became ready arrived with that force-push', () => {
  assert.equal(codex({ events: [FORCE_PUSH(T1), READY(T2)], reactions: [THUMBS_UP(T3)] }).description, TIED);
  // The head's check suite dates its first push, before it left the branch and came back.
  const back = { events: [FORCE_PUSH(T1), READY(T2)], reactions: [THUMBS_UP(T3)], headPushedAt: Date.parse(BEFORE) };
  assert.equal(codex(back).description, TIED);
});

test('thumbs: a force-push to another commit after the head was pushed leaves its arrival unknown', () => {
  // The head came back by a later push that no event records.
  assert.equal(codex({ events: [FORCE_PUSH(T1, OTHER), READY(T2)], reactions: [THUMBS_UP(T3)] }).description, NOT_TIED);
  assert.equal(codex({ events: [FORCE_PUSH(T0, OTHER), READY(T1)], reactions: [THUMBS_UP(T2)] }).description, NOT_TIED);
  // One before the head was first pushed says nothing about it.
  assert.equal(codex({ events: [FORCE_PUSH(BEFORE, OTHER), READY(T1)], reactions: [THUMBS_UP(T2)] }).description, TIED);
});

test('thumbs: the last force-push since the head was pushed decides, whatever order the events are listed in', () => {
  const back = [READY(T3), FORCE_PUSH(T2), FORCE_PUSH(T1, OTHER)];
  assert.equal(codex({ events: back, reactions: [THUMBS_UP(T4)] }).description, TIED);
  const away = [READY(T3), FORCE_PUSH(T2, OTHER), FORCE_PUSH(T1)];
  assert.equal(codex({ events: away, reactions: [THUMBS_UP(T4)] }).description, NOT_TIED);
});

test('thumbs: a Codex verdict on another commit after the request voids it, before or after the 👍', () => {
  // A review requested by comment was still running when the request came, and
  // its 👍 looks the same as the one the request earned.
  for (const [stale, thumbsUp] of [
    [comment(CODEX, CLEAN(OTHER), T2), T3],
    [comment(CODEX, CLEAN(OTHER), T1), T3],
    [comment(CODEX, CLEAN(OTHER), T3), T2],
    [comment(CODEX, FINDINGS(OTHER), T2), T3],
  ]) {
    const s = codex({ comments: [stale], events: [READY(T1)], reactions: [THUMBS_UP(thumbsUp)] });
    assert.equal(s.state, 'pending', `${stale.body.slice(0, 20)} at ${stale.created_at}`);
  }
  const asReview = review(CODEX, FINDINGS(OTHER), T2);
  assert.equal(codex({ reviews: [asReview], events: [READY(T1)], reactions: [THUMBS_UP(T3)] }).state, 'pending');
});

test('thumbs: a later ready request ties the 👍 again after a verdict on another commit voided an earlier one', () => {
  const s = codex({
    comments: [comment(CODEX, CLEAN(OTHER), T2)],
    events: [READY(T1), DRAFTED(T2), READY(T3)],
    reactions: [THUMBS_UP(T4)],
  });
  assert.equal(s.description, TIED);
});

test('thumbs: converting the PR to draft is not a request that ties the 👍 again', () => {
  const s = codex({
    comments: [comment(CODEX, CLEAN(OTHER), T2)],
    events: [READY(T1), DRAFTED(T3)],
    reactions: [THUMBS_UP(T4)],
  });
  assert.equal(s.description, NOT_TIED);
});

test('thumbs: a verdict on another commit from before the request does not void it', () => {
  const s = codex({ comments: [comment(CODEX, FINDINGS(OTHER), BEFORE)], events: [READY(T1)], reactions: [THUMBS_UP(T2)] });
  assert.equal(s.state, 'success');
});

test('thumbs: while Codex shows 👀 on the description nothing counts, and the status says it is reviewing', () => {
  for (const reactions of [[THUMBS_UP(T2), EYES(T3)], [EYES(T3)]]) {
    const s = codex({ events: [READY(T1)], reactions });
    assert.equal(s.state, 'pending', JSON.stringify(reactions));
    assert.equal(s.description, REVIEWING);
  }
});

test('thumbs: a push that cannot be dated ties no 👍, and the status says why', () => {
  const s = codex({ events: [READY(T1)], reactions: [THUMBS_UP(T2)], headPushedAt: null });
  assert.equal(s.state, 'pending');
  assert.equal(s.description, UNDATED);
});

test('thumbs: whatever the 👍 says, the notice that Codex responded without naming the head stays', () => {
  const voided = codex({ comments: [comment(CODEX, CLEAN(OTHER), T2)], events: [READY(T1)], reactions: [THUMBS_UP(T3)] });
  const reworded = codex({ comments: [comment(CODEX, 'Codex had a look; all fine.', T2)], reactions: [THUMBS_UP(T3)] });
  const reviewing = codex({ comments: [comment(CODEX, CLEAN(OTHER), T2)], reactions: [EYES(T3)] });
  for (const [s, description] of [[voided, NOT_TIED], [reworded, NOT_TIED], [reviewing, REVIEWING]]) {
    assert.equal(s.description, description);
    assert.equal(s.notice, RESPONDED);
  }
});

test('thumbs: the 👍 ranks among the verdicts on the head at its own time, losing a tie', () => {
  const ready = { events: [READY(T1)] };
  assert.equal(codex({ ...ready, reviews: [review(CODEX, FINDINGS(HEAD), T3)], reactions: [THUMBS_UP(T2)] }).state, 'pending');
  assert.equal(codex({ ...ready, reviews: [review(CODEX, FINDINGS(HEAD), T2)], reactions: [THUMBS_UP(T3)] }).state, 'success');
  assert.equal(codex({ ...ready, reviews: [review(CODEX, FINDINGS(HEAD), T2)], reactions: [THUMBS_UP(T2)] }).state, 'pending');
});

test('thumbs: a 👍 from anyone but Codex, and any other Codex reaction, is not a verdict', () => {
  for (const r of [reaction('mallory', '+1', T2), reaction(null, '+1', T2), reaction(CODEX, 'hooray', T2)]) {
    const s = codex({ events: [READY(T1)], reactions: [r] });
    assert.equal(s.state, 'pending', JSON.stringify(r));
    assert.equal(s.description, `Waiting for a Codex review of ${HEAD10}`);
  }
});

test('thumbs: a counted 👍 outranks the waiver, and one that does not count leaves the waiver to apply', () => {
  const counted = codex({ comments: [comment(CODEX, LIMIT, T1)], events: [READY(T1)], reactions: [THUMBS_UP(T2)] });
  assert.equal(counted.description, TIED);
  const untied = codex({ comments: [comment(CODEX, LIMIT, T1)], reactions: [THUMBS_UP(T2)] });
  assert.match(untied.description, /^WAIVED:/);
});

test('thumbs: a PR without a boolean draft flag is an error, never a guess', () => {
  assert.throws(() => codex({ draft: undefined, reactions: [THUMBS_UP(T2)] }), /draft flag/);
});

test('thumbs: an event or reaction without a parseable timestamp is an error, never a guess', () => {
  for (const given of [
    { events: [READY(undefined)], reactions: [THUMBS_UP(T2)] },
    { events: [READY(T1), FORCE_PUSH('never')], reactions: [THUMBS_UP(T2)] },
    { events: [READY(T1)], reactions: [THUMBS_UP('soon')] },
  ]) {
    assert.throws(() => codex(given), /no valid timestamp/, JSON.stringify(given));
  }
});

// ------------------------------------------- codex-review: no verdict on the head

test('status: while Codex shows 👀, no out-of-credits answer waives the head or asks for a review', () => {
  // A review is running: its answer, a verdict or a fresh out-of-credits reply,
  // is minutes away.
  for (const [limitAt, headPushedAt] of [[T1, Date.parse(T0)], [BEFORE, Date.parse(T0)], [T1, null]]) {
    const s = codex({ comments: [comment(CODEX, LIMIT, limitAt)], reactions: [EYES(T2)], headPushedAt });
    assert.equal(s.state, 'pending', `${limitAt} ${headPushedAt}`);
    assert.equal(s.description, REVIEWING);
  }
});

test('status: a 👍 that does not count says why ahead of an out-of-credits answer that does not waive', () => {
  const stale = codex({ comments: [comment(CODEX, LIMIT, BEFORE)], reactions: [THUMBS_UP(T2)] });
  assert.equal(stale.description, NOT_TIED);
  const undated = codex({ comments: [comment(CODEX, LIMIT, T1)], reactions: [THUMBS_UP(T2)], headPushedAt: null });
  assert.equal(undated.description, UNDATED);
});

test('status: an out-of-credits answer that does not waive still raises the notice that Codex responded', () => {
  for (const [limitAt, headPushedAt] of [[BEFORE, Date.parse(T0)], [T1, null]]) {
    const s = codex({ comments: [comment(CODEX, LIMIT, limitAt)], headPushedAt });
    assert.equal(s.state, 'pending');
    assert.equal(s.notice, RESPONDED, `${limitAt} ${headPushedAt}`);
  }
  assert.equal(codex({ comments: [comment(CODEX, LIMIT, T1)] }).notice, undefined);
});

// -------------------------------------------------------------- internal-review

test('internal: attestation from Analitiq-Bot naming the head is success', () => {
  assert.equal(internal([comment(BOT, ATTEST(HEAD), T1)]).state, 'success');
});

test('internal: nothing posted yet is pending and names the head awaiting review', () => {
  const s = internal([]);
  assert.equal(s.state, 'pending');
  assert.match(s.description, new RegExp(`Waiting for an internal review of ${HEAD10}`));
  assert.equal(s.notice, undefined);
});

test('internal: an attestation that does not name the head says so instead of "waiting"', () => {
  const swallowed = '<!-- analitiq-internal-review -->\nInternal review clean.\nReviewed commit: ';
  for (const body of [ATTEST(OTHER), swallowed]) {
    const s = internal([comment(BOT, body, T1)]);
    assert.equal(s.state, 'pending');
    assert.match(s.description, new RegExp(`none names ${HEAD10}`));
    assert.match(s.notice, /1 attestation/);
  }
});

test('internal: any Reviewed-commit line of an attestation may name the head', () => {
  const body = `<!-- analitiq-internal-review -->\nReviewed commit: \`${OTHER}\`\nReviewed commit: \`${HEAD}\``;
  assert.equal(internal([comment(BOT, body, T1)]).state, 'success');
});

test('internal: an attestation for the head counts wherever it sits among attestations for older heads', () => {
  assert.equal(internal([comment(BOT, ATTEST(OTHER), T1), comment(BOT, ATTEST(HEAD), T2)]).state, 'success');
  assert.equal(internal([comment(BOT, ATTEST(HEAD), T1), comment(BOT, ATTEST(OTHER), T2)]).state, 'success');
});

test('internal: attestation from any other account, or a deleted one, is ignored', () => {
  assert.equal(internal([comment('mallory', ATTEST(HEAD), T1)]).state, 'pending');
  assert.equal(internal([comment(null, ATTEST(HEAD), T1)]).state, 'pending');
});

test('internal: a comment without the marker is not an attestation', () => {
  const s = internal([comment(BOT, `Internal review clean.\nReviewed commit: \`${HEAD}\``, T1)]);
  assert.equal(s.state, 'pending');
  assert.match(s.description, /Waiting/);
});

test('internal: a 7-character prefix, or a hex run from mid-head, does not name the head', () => {
  for (const sha of [HEAD.slice(0, 7), HEAD.slice(5, 17)]) {
    const body = `<!-- analitiq-internal-review -->\nReviewed commit: \`${sha}\``;
    assert.equal(internal([comment(BOT, body, T1)]).state, 'pending', sha);
  }
});

test('internal: a shell-mangled attestation (no backticks, either quote) and an upper-case SHA are honored', () => {
  for (const [open, sha] of [['', HEAD], ["'", HEAD], ['"', HEAD], ['`', HEAD.toUpperCase()]]) {
    const body = `<!-- analitiq-internal-review -->\nReviewed commit: ${open}${sha}${open}`;
    assert.equal(internal([comment(BOT, body, T1)]).state, 'success', `${open}${sha}`);
  }
});

test('internal: a null body is ignored, not a crash', () => {
  assert.equal(internal([comment(BOT, null, T1)]).state, 'pending');
});

// ------------------------------------------------------------------------- run

// Records every status posted; serves canned PR data. `commentsByCall` lets a
// test change what the comment list returns on successive reads. REST methods
// answer in Octokit's `{ data }` envelope and only `paginate` unwraps it, so
// code that skips `paginate` (and would read one page) cannot pass.
function fakeGithub({
  prs,
  commentsByCall,
  reviews = [],
  reactions = [],
  events = [],
  statuses = [],
  suites = [suite(T0)],
  failFor = [],
}) {
  const posted = [];
  let reads = 0;
  const rest = {
    pulls: {
      get: async ({ pull_number }) => {
        if (failFor.includes(pull_number)) throw new Error(`boom ${pull_number}`);
        return { data: prs.find((p) => p.number === pull_number) };
      },
      list: async () => ({ data: prs.filter((p) => p.state === 'open') }),
      listReviews: async () => ({ data: reviews }),
    },
    issues: {
      listComments: async () => ({ data: commentsByCall[Math.min(reads++, commentsByCall.length - 1)] }),
      listEvents: async () => ({ data: events }),
    },
    reactions: {
      listForIssue: async () => ({ data: reactions }),
    },
    checks: {
      listSuitesForRef: async () => ({ data: { total_count: suites.length, check_suites: suites } }),
    },
    repos: {
      // newest first, as the API returns them
      listCommitStatusesForRef: async () => ({ data: statuses }),
      createCommitStatus: async (s) => {
        // Nothing the API would reject reaches it, the crash description included.
        assertPostable(s.description, 'the posted description');
        posted.push(s);
        return { data: {} };
      },
    },
  };
  const paginate = async (fn, params) => {
    const { data } = await fn(params);
    return Array.isArray(data) ? data : data.check_suites;
  };
  return { posted, github: { rest, paginate } };
}

const fakeCore = () => {
  const log = { failed: [], errors: [], notices: [] };
  return {
    log,
    core: {
      info() {},
      notice: (m) => log.notices.push(m),
      error: (m) => log.errors.push(m),
      setFailed: (m) => log.failed.push(m),
    },
  };
};

const openPr = (number = 7) => ({
  number,
  state: 'open',
  head: { sha: HEAD },
  html_url: `https://example.test/pr/${number}`,
  created_at: BEFORE,
  updated_at: T3,
  draft: false,
});
const ctx = (payload) => ({ repo: { owner: 'o', repo: 'r' }, payload });
const pushEvent = ctx({ pull_request: { number: 7, head: { sha: HEAD }, updated_at: T3 } });
const commentEvent = ctx({ issue: { number: 7, pull_request: {} } });
const status = (context, state, description, at) => ({ context, state, description, created_at: at });
const suite = (at) => ({ created_at: at });
const WAIVED_DESCRIPTION = `WAIVED: Codex is out of credits; ${HEAD10} was not reviewed`;
const CLEAN_DESCRIPTION = `Codex found no major issues in ${HEAD10}`;
const WAITING_INTERNAL = `Waiting for an internal review of ${HEAD10}`;
const of = (posted, context) => posted.filter((s) => s.context === context);

test('run: a PR event posts both statuses on the head', async () => {
  const { github, posted } = fakeGithub({
    prs: [openPr()],
    commentsByCall: [[comment(CODEX, CLEAN(HEAD), T1), comment(BOT, ATTEST(OTHER), T1)]],
  });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(of(posted, 'codex-review').map((s) => s.state), ['success']);
  assert.deepEqual(of(posted, 'internal-review').map((s) => s.state), ['pending']);
  assert.ok(posted.every((s) => s.sha === HEAD));
});

test('run: a comment on an open PR evaluates it', async () => {
  const { github, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(BOT, ATTEST(HEAD), T1)]] });
  await gate.run({ github, context: commentEvent, core: fakeCore().core });
  assert.deepEqual(of(posted, 'internal-review').map((s) => s.state), ['success']);
});

test('run: a comment on a plain issue is ignored', async () => {
  const { github, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[]] });
  await gate.run({ github, context: ctx({ issue: { number: 7 } }), core: fakeCore().core });
  assert.deepEqual(posted, []);
});

test('run: a closed PR gets no status', async () => {
  const { github, posted } = fakeGithub({ prs: [{ ...openPr(), state: 'closed' }], commentsByCall: [[]] });
  await gate.run({ github, context: commentEvent, core: fakeCore().core });
  assert.deepEqual(posted, []);
});

test('run: an identical latest status is not re-posted', async () => {
  const comments = [comment(CODEX, CLEAN(HEAD), T1), comment(BOT, ATTEST(HEAD), T1)];
  const first = fakeGithub({ prs: [openPr()], commentsByCall: [comments] });
  await gate.run({ github: first.github, context: pushEvent, core: fakeCore().core });
  const statuses = first.posted.map((s) => status(s.context, s.state, s.description, T2));

  const second = fakeGithub({ prs: [openPr()], commentsByCall: [comments], statuses });
  await gate.run({ github: second.github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(second.posted, []);
});

test('run: a status whose state is unchanged but whose description went stale is re-posted', async () => {
  const statuses = [status('codex-review', 'pending', `Waiting for a Codex review of ${HEAD10}`, T0)];
  const { github, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(CODEX, FINDINGS(HEAD), T1)]], statuses });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(of(posted, 'codex-review').map((s) => [s.state, s.description]), [['pending', `No clean Codex verdict for ${HEAD10} yet`]]);
});

test('run: an existing success is demoted when a later findings verdict voids it', async () => {
  const { github, posted } = fakeGithub({
    prs: [openPr()],
    commentsByCall: [[comment(CODEX, CLEAN(HEAD), T1)]],
    reviews: [review(CODEX, FINDINGS(HEAD), T2)],
    statuses: [status('codex-review', 'success', CLEAN_DESCRIPTION, T1)],
  });
  await gate.run({ github, context: commentEvent, core: fakeCore().core });
  assert.deepEqual(of(posted, 'codex-review').map((s) => s.state), ['pending']);
});

test('run: the NEWEST status of a context is the one compared against', async () => {
  const statuses = [
    status('codex-review', 'success', CLEAN_DESCRIPTION, T2),
    status('codex-review', 'pending', `Waiting for a Codex review of ${HEAD10}`, T0),
  ];
  const { github, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[]], statuses });
  await gate.run({ github, context: commentEvent, core: fakeCore().core });
  assert.deepEqual(of(posted, 'codex-review').map((s) => s.state), ['pending']);
});

test('run: a first status on a brand-new head is decided by the fresh read', async () => {
  const { github, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[], [comment(CODEX, CLEAN(HEAD), T1)]] });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(of(posted, 'codex-review').map((s) => s.state), ['success']);
});

test('run: an existing success alone triggers the re-read, and a fresh read that still supports it posts nothing', async () => {
  const { github, posted } = fakeGithub({
    prs: [openPr()],
    // first read predates the verdict; the re-read sees it
    commentsByCall: [[], [comment(CODEX, CLEAN(HEAD), T1)]],
    statuses: [status('codex-review', 'success', CLEAN_DESCRIPTION, T2), status('internal-review', 'pending', WAITING_INTERNAL, T0)],
  });
  await gate.run({ github, context: commentEvent, core: fakeCore().core });
  assert.deepEqual(posted, []);
});

test('run: the head is dated by its EARLIEST check suite', async () => {
  const { github, posted } = fakeGithub({
    prs: [openPr()],
    commentsByCall: [[comment(CODEX, LIMIT, T1)]],
    suites: [suite(T2), suite(T0), suite(T3)],
  });
  await gate.run({ github, context: commentEvent, core: fakeCore().core });
  assert.equal(of(posted, 'codex-review')[0].description, WAIVED_DESCRIPTION);
});

test('run: a head with no check suite is not waived', async () => {
  const { github, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(CODEX, LIMIT, T1)]], suites: [] });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(of(posted, 'codex-review').map((s) => s.state), ['pending']);
  assert.match(of(posted, 'codex-review')[0].description, /no check suite/);
});

test('run: a check suite without a valid date is an error, however many suites there are', async () => {
  // Array sort never hands `undefined` to its comparator, and never calls it
  // for one element, so validating inside a sort would skip these.
  for (const suites of [[suite(null)], [suite(undefined), suite(T2)], [suite(T0), suite(null)], [suite('not a date')]]) {
    const { github, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[]], suites });
    await assert.rejects(gate.run({ github, context: commentEvent, core: fakeCore().core }), /check suite/);
    assert.deepEqual(posted.map((s) => [s.context, s.state]).sort(), [['codex-review', 'error'], ['internal-review', 'error']]);
  }
});

test('run: the waiver does not depend on which event, or which run, got there first', async () => {
  for (const context of [pushEvent, commentEvent, ctx({})]) {
    const { github, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(CODEX, LIMIT, T1)]] });
    await gate.run({ github, context, core: fakeCore().core });
    assert.equal(of(posted, 'codex-review')[0].description, WAIVED_DESCRIPTION);
  }
});

test('run: the gate\'s own earlier statuses never date the head', async () => {
  // A first `pending`, or a crash's `error`, posted after Codex's answer.
  for (const statuses of [
    [status('codex-review', 'pending', `Waiting for a Codex review of ${HEAD10}`, T2)],
    [status('codex-review', 'error', gate.crashDescription('x'), T3), status('codex-review', 'success', WAIVED_DESCRIPTION, T2)],
  ]) {
    const { github, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(CODEX, LIMIT, T1)]], statuses });
    await gate.run({ github, context: commentEvent, core: fakeCore().core });
    assert.equal(of(posted, 'codex-review')[0].description, WAIVED_DESCRIPTION);
  }
});

test('run: a Codex 👍 is read from the description\'s reactions and tied by the PR\'s draft flag and events', async () => {
  for (const [pr, events, expected] of [
    [openPr(), [READY(T1)], ['success', TIED]],
    [{ ...openPr(), created_at: T1 }, [], ['success', TIED]],
    [{ ...openPr(), created_at: T1, draft: true }, [], ['pending', NOT_TIED]],
  ]) {
    const { github, posted } = fakeGithub({ prs: [pr], commentsByCall: [[]], reactions: [THUMBS_UP(T2)], events });
    await gate.run({ github, context: pushEvent, core: fakeCore().core });
    assert.deepEqual(of(posted, 'codex-review').map((s) => [s.state, s.description]), [expected], JSON.stringify(pr));
  }
});

test('run: a repository_dispatch, which names no PR, sweeps every open PR', async () => {
  // How whoever sees Codex's 👍 wakes the gate: a reaction triggers no workflow.
  const dispatch = ctx({ action: 'pr-gate', branch: 'main', client_payload: {} });
  const { github, posted } = fakeGithub({ prs: [openPr(7), openPr(8)], commentsByCall: [[]] });
  await gate.run({ github, context: dispatch, core: fakeCore().core });
  assert.equal(of(posted, 'codex-review').length, 2);
});

test('run: a waiver once posted is not what keeps a head waived', async () => {
  const { github, posted } = fakeGithub({
    prs: [openPr()],
    commentsByCall: [[]],
    statuses: [status('codex-review', 'success', WAIVED_DESCRIPTION, T2)],
  });
  await gate.run({ github, context: commentEvent, core: fakeCore().core });
  assert.deepEqual(of(posted, 'codex-review').map((s) => s.state), ['pending']);
});

test('run: every status links back to the PR', async () => {
  const { github, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[]] });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.equal(posted.length, 2);
  assert.ok(posted.every((s) => s.target_url === 'https://example.test/pr/7'));
});

test('run: a near-miss is written to the run log as a notice', async () => {
  const { github } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(CODEX, CLEAN(OTHER), T1), comment(BOT, ATTEST(OTHER), T1)]] });
  const { core, log } = fakeCore();
  await gate.run({ github, context: pushEvent, core });
  assert.equal(log.notices.length, 2);
  assert.ok(log.notices.every((n) => n.startsWith('PR #7:')));
});

test('run: a crash is surfaced on the PR as an error status for both contexts, then rethrown', async () => {
  const { github, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[]] });
  github.rest.pulls.listReviews = async () => {
    throw new Error('x'.repeat(400));
  };
  await assert.rejects(gate.run({ github, context: pushEvent, core: fakeCore().core }), /xxx/);
  assert.deepEqual(posted.map((s) => [s.context, s.state]).sort(), [['codex-review', 'error'], ['internal-review', 'error']]);
  assert.ok(posted.every((s) => s.sha === HEAD && s.description.length <= gate.MAX_STATUS_DESCRIPTION));
});

test('postable: the bound is the one the status API documents', () => {
  assert.equal(gate.MAX_STATUS_DESCRIPTION, 140);
});

test('postable: a character outside the BMP is replaced, and what is left is cut to the bound', () => {
  assert.equal(gate.postable('a👀b'), 'a?b');
  assert.equal(gate.postable('x'.repeat(200)), 'x'.repeat(gate.MAX_STATUS_DESCRIPTION));
});

test('run: a crash message carrying an emoji still posts', async () => {
  const { github, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[]] });
  github.rest.pulls.listReviews = async () => {
    throw new Error('reviews API down 👀');
  };
  await assert.rejects(gate.run({ github, context: pushEvent, core: fakeCore().core }), /reviews API down/);
  assert.equal(posted.length, 2);
});

test('run: an emoji straddling the cut of a long crash message leaves no half behind', async () => {
  const { github, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[]] });
  // Where the gate's own wording ends, so a reworded prefix moves the emoji
  // with it instead of leaving this test grading nothing.
  const message = 'm'.repeat(200);
  const written = gate.crashDescription(new Error(message)).indexOf(message);
  const filler = 'x'.repeat(gate.MAX_STATUS_DESCRIPTION - written - 1);
  github.rest.pulls.listReviews = async () => {
    throw new Error(`${filler}👀${'y'.repeat(50)}`);
  };
  await assert.rejects(gate.run({ github, context: pushEvent, core: fakeCore().core }), /xxx/);
  assert.equal(posted.length, 2);
  assert.ok(posted.every((s) => !/[\uD800-\uDFFF]/.test(s.description)), 'a lone surrogate reached the API');
  // The emoji did land on the cut: it is the last character kept, repaired.
  assert.ok(
    posted.every((s) => s.description.length === gate.MAX_STATUS_DESCRIPTION && s.description.endsWith('?')),
    'the emoji did not straddle the cut, so nothing was graded',
  );
});

test('run: a crash demotes an existing success on both contexts', async () => {
  const { github, posted } = fakeGithub({
    prs: [openPr()],
    commentsByCall: [[]],
    statuses: [
      status('codex-review', 'success', CLEAN_DESCRIPTION, T2),
      status('internal-review', 'success', `Internal review clean on ${HEAD10}`, T2),
    ],
  });
  github.rest.pulls.listReviews = async () => {
    throw new Error('reviews API down');
  };
  await assert.rejects(gate.run({ github, context: commentEvent, core: fakeCore().core }), /reviews API down/);
  assert.deepEqual(posted.map((s) => [s.context, s.state]).sort(), [['codex-review', 'error'], ['internal-review', 'error']]);
});

test('run: a failed read of the statuses, or of the check suites, still surfaces as an error status on both contexts', async () => {
  for (const [api, method] of [['repos', 'listCommitStatusesForRef'], ['checks', 'listSuitesForRef']]) {
    const { github, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[]] });
    github.rest[api][method] = async () => {
      throw new Error(`${method} down`);
    };
    await assert.rejects(gate.run({ github, context: commentEvent, core: fakeCore().core }), new RegExp(`${method} down`));
    assert.deepEqual(posted.map((s) => [s.context, s.state]).sort(), [['codex-review', 'error'], ['internal-review', 'error']]);
  }
});

test('run: when only the second status fails to post, neither context is left looking current', async () => {
  const { github, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(CODEX, CLEAN(HEAD), T1)]] });
  const record = github.rest.repos.createCommitStatus;
  let calls = 0;
  github.rest.repos.createCommitStatus = async (s) => {
    if (++calls === 2) throw new Error('statuses API blip');
    return record(s);
  };
  await assert.rejects(gate.run({ github, context: pushEvent, core: fakeCore().core }), /statuses API blip/);
  assert.deepEqual(posted.map((s) => [s.context, s.state]), [
    ['codex-review', 'success'],
    ['codex-review', 'error'],
    ['internal-review', 'error'],
  ]);
});

test('run: a crash that repeats does not re-post an identical error status', async () => {
  const description = gate.crashDescription(new Error('reviews API down'));
  const { github, posted } = fakeGithub({
    prs: [openPr()],
    commentsByCall: [[]],
    statuses: [status('codex-review', 'error', description, T2), status('internal-review', 'error', description, T2)],
  });
  github.rest.pulls.listReviews = async () => {
    throw new Error('reviews API down');
  };
  await assert.rejects(gate.run({ github, context: commentEvent, core: fakeCore().core }), /reviews API down/);
  assert.deepEqual(posted, []);
});

test('run: a repeated crash whose message had to be repaired is still recognized as unchanged', async () => {
  // GitHub holds the repaired description, so that is what the next run has to
  // compare against; against the raw message it would re-post every run and
  // spend the commit's status budget.
  const description = gate.crashDescription(new Error('reviews API down ?'));
  const { github, posted } = fakeGithub({
    prs: [openPr()],
    commentsByCall: [[]],
    statuses: [status('codex-review', 'error', description, T2), status('internal-review', 'error', description, T2)],
  });
  github.rest.pulls.listReviews = async () => {
    throw new Error('reviews API down 👀');
  };
  await assert.rejects(gate.run({ github, context: commentEvent, core: fakeCore().core }), /reviews API down/);
  assert.deepEqual(posted, []);
});

test('run: failing to post the error status does not mask the crash that caused it', async () => {
  const { github } = fakeGithub({ prs: [openPr()], commentsByCall: [[]] });
  github.rest.pulls.listReviews = async () => {
    throw new Error('reviews API down');
  };
  github.rest.repos.createCommitStatus = async () => {
    throw new Error('statuses API down');
  };
  const { core, log } = fakeCore();
  await assert.rejects(gate.run({ github, context: pushEvent, core }), /reviews API down/);
  assert.equal(log.errors.length, 2);
});

test('run: the sweep evaluates every open PR and one failure does not starve the rest', async () => {
  const { github, posted } = fakeGithub({ prs: [openPr(7), openPr(8)], commentsByCall: [[]], failFor: [7] });
  const { core, log } = fakeCore();
  await gate.run({ github, context: ctx({}), core });
  assert.ok(posted.length > 0, 'PR 8 was still evaluated');
  assert.equal(log.failed.length, 1);
  assert.match(log.failed[0], /#7/);
  assert.equal(log.errors.length, 1);
  assert.match(log.errors[0], /pr-gate\.test\.js/, 'the stack, not just the message');
});
