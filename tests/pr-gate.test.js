'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../.github/scripts/pr-gate.js');

const HEAD = '99ed81fce1f091223f9fcbac24070ea192da1622';
const OTHER = '128ed7ba3cf9387775318f9982b6b816193d4f47';
const BASE = 'bd8be443d5691dcc8043ea031f94a5d9be622913';
const MERGE_BASE = '6db5457aa1b2c3d4e5f60718293a4b5c6d7e8f90';
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

// The check-run title bound, stated here rather than asked of the code that
// implements it.
const MAX_TITLE_LENGTH = 255;

// `post` caps any title over the bound, so nothing the gate says can block a
// PR. These are the gate's own words, though, and a reader should never be
// shown a cut: what a builder returns already fits.
const wellWorded = (status) => {
  assert.ok(status.description.length <= MAX_TITLE_LENGTH, `the wording is over the bound: ${status.description}`);
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

// Records every check run created; serves canned PR data. `commentsByCall`
// lets a test change what the comment list returns on successive reads. REST
// methods answer in Octokit's `{ data }` envelope and only `paginate` unwraps
// it, so code that skips `paginate` (and would read one page) cannot pass.
function fakeGithub({
  prs,
  commentsByCall,
  reviews = [],
  reactions = [],
  events = [],
  checkRuns = [],
  suites = [suite(T0)],
  files = [],
  manifests = {},
  compareFails = null,
  failFor = [],
}) {
  const posted = [];
  const created = [];
  const checkRunReads = [];
  const statusReads = [];
  const compared = [];
  const read = [];
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
      listForRef: async ({ ref, check_name }) => {
        checkRunReads.push(ref);
        const runs = checkRuns.filter((r) => check_name === undefined || r.name === check_name);
        return { data: { total_count: runs.length, check_runs: runs } };
      },
      create: async (run) => {
        created.push(run);
        return { data: { id: 1000 + created.length, app: { slug: GATE_APP } } };
      },
    },
    repos: {
      compareCommitsWithBasehead: async ({ basehead }) => {
        compared.push(basehead);
        if (compareFails) throw compareFails;
        return { data: { files, merge_base_commit: { sha: MERGE_BASE } } };
      },
      getContent: async ({ path, ref }) => {
        read.push(`${path}@${ref}`);
        const text = manifests[path]?.[ref];
        if (text === undefined) throw apiError(404);
        return { data: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') } };
      },
      // Never called in production any more; kept only so a test can prove that.
      listCommitStatusesForRef: async ({ ref }) => {
        statusReads.push(ref);
        return { data: [] };
      },
      // Also never called any more; the `posted` array only exists so the
      // `assert.deepEqual(posted, [])` guards below can fail if it ever is.
      createCommitStatus: async (params) => {
        posted.push(params);
        return { data: {} };
      },
    },
  };
  const paginate = async (fn, params) => {
    const { data } = await fn(params);
    return Array.isArray(data) ? data : (data.check_suites ?? data.check_runs);
  };
  return { posted, created, checkRunReads, statusReads, compared, read, github: { rest, paginate } };
}

// What Octokit throws for a failed request: an error carrying the HTTP status.
const apiError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

const fakeCore = () => {
  const log = { failed: [], errors: [], notices: [], warnings: [] };
  return {
    log,
    core: {
      info() {},
      warning: (m) => log.warnings.push(m),
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
  base: { sha: BASE },
  changed_files: 0,
  html_url: `https://example.test/pr/${number}`,
  created_at: BEFORE,
  updated_at: T3,
  draft: false,
});
// serverUrl/runId mirror the fields a real actions/github-script context
// carries; RUN_URL is what run() must build details_url from.
const ctx = (eventName, payload) => ({
  eventName,
  repo: { owner: 'o', repo: 'r' },
  payload,
  serverUrl: 'https://example.test',
  runId: 42,
});
const RUN_URL = 'https://example.test/o/r/actions/runs/42';
const pushEvent = ctx('pull_request_target', { pull_request: { number: 7, head: { sha: HEAD }, updated_at: T3 } });
const commentEvent = ctx('issue_comment', { issue: { number: 7, pull_request: {} } });
const suite = (at) => ({ created_at: at });
const WAIVED_DESCRIPTION = `WAIVED: Codex is out of credits; ${HEAD10} was not reviewed`;
const CLEAN_DESCRIPTION = `Codex found no major issues in ${HEAD10}`;
const WAITING_INTERNAL = `Waiting for an internal review of ${HEAD10}`;
const of = (created, name) => created.filter((r) => r.name === name);
// The old commit-status vocabulary a check run maps back to, for assertions
// that read the same way the pre-App-check-run tests did.
const stateOf = (run) => (run.status === 'in_progress' ? 'pending' : run.conclusion === 'success' ? 'success' : 'error');
// Turns what post() sent to checks.create back into the shape checks.listForRef
// serves, so one run's own output can seed the next run's history.
const asHistory = (runs, at) =>
  runs.map((r, i) => checkRun({ id: i + 1, at, name: r.name, status: r.status, conclusion: r.conclusion, title: r.output.title }));

test('run: a PR event posts both check runs on the head', async () => {
  const { github, created } = fakeGithub({
    prs: [openPr()],
    commentsByCall: [[comment(CODEX, CLEAN(HEAD), T1), comment(BOT, ATTEST(OTHER), T1)]],
  });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(of(created, 'codex-review').map(stateOf), ['success']);
  assert.deepEqual(of(created, 'internal-review').map(stateOf), ['pending']);
  assert.ok(created.every((r) => r.head_sha === HEAD));
});

test('run: a comment on an open PR evaluates it', async () => {
  const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(BOT, ATTEST(HEAD), T1)]] });
  await gate.run({ github, context: commentEvent, core: fakeCore().core });
  assert.deepEqual(of(created, 'internal-review').map(stateOf), ['success']);
});

test('run: a comment on a plain issue is ignored', async () => {
  const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[]] });
  await gate.run({ github, context: ctx('issue_comment', { issue: { number: 7 } }), core: fakeCore().core });
  assert.deepEqual(created, []);
});

test('run: a closed PR gets no check run', async () => {
  const { github, created } = fakeGithub({ prs: [{ ...openPr(), state: 'closed' }], commentsByCall: [[]] });
  await gate.run({ github, context: commentEvent, core: fakeCore().core });
  assert.deepEqual(created, []);
});

test('run: an identical latest check run is not re-posted', async () => {
  const comments = [comment(CODEX, CLEAN(HEAD), T1), comment(BOT, ATTEST(HEAD), T1)];
  const first = fakeGithub({ prs: [openPr()], commentsByCall: [comments] });
  await gate.run({ github: first.github, context: pushEvent, core: fakeCore().core });
  const checkRuns = asHistory(first.created, T2);

  const second = fakeGithub({ prs: [openPr()], commentsByCall: [comments], checkRuns });
  await gate.run({ github: second.github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(second.created, []);
});

test('run: a check run whose state is unchanged but whose title went stale is re-posted', async () => {
  const checkRuns = [checkRun({ id: 1, at: T0, name: 'codex-review', status: 'in_progress', title: WAITING_CODEX })];
  const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(CODEX, FINDINGS(HEAD), T1)]], checkRuns });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(
    of(created, 'codex-review').map((r) => [stateOf(r), r.output.title]),
    [['pending', `No clean Codex verdict for ${HEAD10} yet`]],
  );
});

test('run: an existing success is demoted when a later findings verdict voids it', async () => {
  const checkRuns = [checkRun({ id: 1, at: T1, name: 'codex-review', status: 'completed', conclusion: 'success', title: CLEAN_DESCRIPTION })];
  const { github, created } = fakeGithub({
    prs: [openPr()],
    commentsByCall: [[comment(CODEX, CLEAN(HEAD), T1)]],
    reviews: [review(CODEX, FINDINGS(HEAD), T2)],
    checkRuns,
  });
  await gate.run({ github, context: commentEvent, core: fakeCore().core });
  assert.deepEqual(of(created, 'codex-review').map(stateOf), ['pending']);
});

test('run: the newest check run of a name is the one compared against', async () => {
  const checkRuns = [
    checkRun({ id: 1, at: T2, name: 'codex-review', status: 'completed', conclusion: 'success', title: CLEAN_DESCRIPTION }),
    checkRun({ id: 2, at: T0, name: 'codex-review', status: 'in_progress', title: WAITING_CODEX }),
  ];
  const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[]], checkRuns });
  await gate.run({ github, context: commentEvent, core: fakeCore().core });
  assert.deepEqual(of(created, 'codex-review').map(stateOf), ['pending']);
});

test('run: a first check run on a brand-new head is decided by the fresh read', async () => {
  const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[], [comment(CODEX, CLEAN(HEAD), T1)]] });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(of(created, 'codex-review').map(stateOf), ['success']);
});

test('run: an existing success alone triggers the re-read, and a fresh read that still supports it posts nothing', async () => {
  const checkRuns = [
    checkRun({ id: 1, at: T2, name: 'codex-review', status: 'completed', conclusion: 'success', title: CLEAN_DESCRIPTION }),
    checkRun({ id: 2, at: T0, name: 'internal-review', status: 'in_progress', title: WAITING_INTERNAL }),
  ];
  const { github, created } = fakeGithub({
    prs: [openPr()],
    // first read predates the verdict; the re-read sees it
    commentsByCall: [[], [comment(CODEX, CLEAN(HEAD), T1)]],
    checkRuns,
  });
  await gate.run({ github, context: commentEvent, core: fakeCore().core });
  assert.deepEqual(created, []);
});

test('run: the head is dated by its EARLIEST check suite', async () => {
  const { github, created } = fakeGithub({
    prs: [openPr()],
    commentsByCall: [[comment(CODEX, LIMIT, T1)]],
    suites: [suite(T2), suite(T0), suite(T3)],
  });
  await gate.run({ github, context: commentEvent, core: fakeCore().core });
  assert.equal(of(created, 'codex-review')[0].output.title, WAIVED_DESCRIPTION);
});

test('run: a head with no check suite is not waived', async () => {
  const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(CODEX, LIMIT, T1)]], suites: [] });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(of(created, 'codex-review').map(stateOf), ['pending']);
  assert.match(of(created, 'codex-review')[0].output.title, /no check suite/);
});

test('run: a check suite without a valid date is an error, however many suites there are', async () => {
  // Array sort never hands `undefined` to its comparator, and never calls it
  // for one element, so validating inside a sort would skip these.
  for (const suites of [[suite(null)], [suite(undefined), suite(T2)], [suite(T0), suite(null)], [suite('not a date')]]) {
    const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[]], suites });
    await assert.rejects(gate.run({ github, context: commentEvent, core: fakeCore().core }), /check suite/);
    assert.deepEqual(verdicts(created).map(([name, , status, conclusion]) => [name, status, conclusion]), [
      ['codex-review', 'completed', 'failure'],
      ['internal-review', 'completed', 'failure'],
    ]);
  }
});

test('run: the waiver does not depend on which event, or which run, got there first', async () => {
  for (const context of [pushEvent, commentEvent, ctx('schedule', {})]) {
    const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(CODEX, LIMIT, T1)]] });
    await gate.run({ github, context, core: fakeCore().core });
    assert.equal(of(created, 'codex-review')[0].output.title, WAIVED_DESCRIPTION);
  }
});

test('run: the gate\'s own earlier check runs never date the head', async () => {
  // A first `pending`, or a crash's `failure`, posted after Codex's answer.
  for (const checkRuns of [
    [checkRun({ id: 1, at: T2, name: 'codex-review', status: 'in_progress', title: WAITING_CODEX })],
    [
      checkRun({ id: 1, at: T3, name: 'codex-review', status: 'completed', conclusion: 'failure', title: gate.crashDescription(new Error('x')) }),
      checkRun({ id: 2, at: T2, name: 'codex-review', status: 'completed', conclusion: 'success', title: WAIVED_DESCRIPTION }),
    ],
  ]) {
    const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(CODEX, LIMIT, T1)]], checkRuns });
    await gate.run({ github, context: commentEvent, core: fakeCore().core });
    assert.equal(of(created, 'codex-review')[0].output.title, WAIVED_DESCRIPTION);
  }
});

test('run: a Codex 👍 is read from the description\'s reactions and tied by the PR\'s draft flag and events', async () => {
  for (const [pr, events, expected] of [
    [openPr(), [READY(T1)], ['success', TIED]],
    [{ ...openPr(), created_at: T1 }, [], ['success', TIED]],
    [{ ...openPr(), created_at: T1, draft: true }, [], ['pending', NOT_TIED]],
  ]) {
    const { github, created } = fakeGithub({ prs: [pr], commentsByCall: [[]], reactions: [THUMBS_UP(T2)], events });
    await gate.run({ github, context: pushEvent, core: fakeCore().core });
    assert.deepEqual(of(created, 'codex-review').map((r) => [stateOf(r), r.output.title]), [expected], JSON.stringify(pr));
  }
});

test('run: a repository_dispatch, which names no PR, sweeps every open PR', async () => {
  // How whoever sees Codex's 👍 wakes the gate: a reaction triggers no workflow.
  const dispatch = ctx('repository_dispatch', { action: 'pr-gate', branch: 'main', client_payload: {} });
  const { github, created } = fakeGithub({ prs: [openPr(7), openPr(8)], commentsByCall: [[]] });
  await gate.run({ github, context: dispatch, core: fakeCore().core });
  assert.equal(of(created, 'codex-review').length, 2);
});

test('run: a waiver once posted is not what keeps a head waived', async () => {
  const checkRuns = [checkRun({ id: 1, at: T2, name: 'codex-review', status: 'completed', conclusion: 'success', title: WAIVED_DESCRIPTION })];
  const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[]], checkRuns });
  await gate.run({ github, context: commentEvent, core: fakeCore().core });
  assert.deepEqual(of(created, 'codex-review').map(stateOf), ['pending']);
});

test('run: every check run links to the workflow run that posted it', async () => {
  const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[]] });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.equal(created.length, 2);
  assert.ok(created.every((r) => r.details_url === RUN_URL));
});

test('run: a near-miss is written to the run log as a notice', async () => {
  const { github } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(CODEX, CLEAN(OTHER), T1), comment(BOT, ATTEST(OTHER), T1)]] });
  const { core, log } = fakeCore();
  await gate.run({ github, context: pushEvent, core });
  assert.equal(log.notices.length, 2);
  assert.ok(log.notices.every((n) => n.startsWith('PR #7:')));
});

test('run: a crash is surfaced as a failed check run on both names, then rethrown', async () => {
  const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[]] });
  github.rest.pulls.listReviews = async () => {
    throw new Error('x'.repeat(400));
  };
  await assert.rejects(gate.run({ github, context: pushEvent, core: fakeCore().core }), /xxx/);
  assert.deepEqual(verdicts(created).map(([name, , status, conclusion]) => [name, status, conclusion]), [
    ['codex-review', 'completed', 'failure'],
    ['internal-review', 'completed', 'failure'],
  ]);
  assert.ok(created.every((r) => r.head_sha === HEAD && r.output.title.length <= MAX_TITLE_LENGTH));
});

test('run: a crash message carrying an emoji still posts', async () => {
  const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[]] });
  github.rest.pulls.listReviews = async () => {
    throw new Error('reviews API down 👀');
  };
  await assert.rejects(gate.run({ github, context: pushEvent, core: fakeCore().core }), /reviews API down/);
  assert.equal(created.length, 2);
});

test('run: a crash demotes an existing success on both check runs', async () => {
  const checkRuns = [
    checkRun({ id: 1, at: T2, name: 'codex-review', status: 'completed', conclusion: 'success', title: CLEAN_DESCRIPTION }),
    checkRun({ id: 2, at: T2, name: 'internal-review', status: 'completed', conclusion: 'success', title: `Internal review clean on ${HEAD10}` }),
  ];
  const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[]], checkRuns });
  github.rest.pulls.listReviews = async () => {
    throw new Error('reviews API down');
  };
  await assert.rejects(gate.run({ github, context: commentEvent, core: fakeCore().core }), /reviews API down/);
  assert.deepEqual(verdicts(created).map(([name, , status, conclusion]) => [name, status, conclusion]), [
    ['codex-review', 'completed', 'failure'],
    ['internal-review', 'completed', 'failure'],
  ]);
});

test('run: a failed read of the check-run history, or of the check suites, still surfaces as a failed check run on both names', async () => {
  for (const [api, method] of [['checks', 'listForRef'], ['checks', 'listSuitesForRef']]) {
    const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[]] });
    github.rest[api][method] = async () => {
      throw new Error(`${method} down`);
    };
    await assert.rejects(gate.run({ github, context: commentEvent, core: fakeCore().core }), new RegExp(`${method} down`));
    assert.deepEqual(verdicts(created).map(([name, , status, conclusion]) => [name, status, conclusion]), [
      ['codex-review', 'completed', 'failure'],
      ['internal-review', 'completed', 'failure'],
    ]);
  }
});

test('run: when only the second check run fails to post, neither name is left looking current', async () => {
  const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(CODEX, CLEAN(HEAD), T1)]] });
  const record = github.rest.checks.create;
  let calls = 0;
  github.rest.checks.create = async (run) => {
    if (++calls === 2) throw new Error('checks API blip');
    return record(run);
  };
  await assert.rejects(gate.run({ github, context: pushEvent, core: fakeCore().core }), /checks API blip/);
  assert.deepEqual(created.map((r) => [r.name, stateOf(r)]), [
    ['codex-review', 'success'],
    ['codex-review', 'error'],
    ['internal-review', 'error'],
  ]);
});

test('run: a crash that repeats does not re-post an identical failed check run', async () => {
  const title = gate.crashDescription(new Error('reviews API down'));
  const checkRuns = [
    checkRun({ id: 1, at: T2, name: 'codex-review', status: 'completed', conclusion: 'failure', title }),
    checkRun({ id: 2, at: T2, name: 'internal-review', status: 'completed', conclusion: 'failure', title }),
  ];
  const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[]], checkRuns });
  github.rest.pulls.listReviews = async () => {
    throw new Error('reviews API down');
  };
  await assert.rejects(gate.run({ github, context: commentEvent, core: fakeCore().core }), /reviews API down/);
  assert.deepEqual(created, []);
});

test('run: a repeated crash whose title had to be capped is still recognized as unchanged', async () => {
  // GitHub holds the capped title, so that is what the next run has to compare
  // against; against the raw message it would re-post every run and spend the
  // App's check-run history on repeats of the same crash.
  const raw = `reviews API down ${'x'.repeat(400)}`;
  const title = gate.crashDescription(new Error(raw)).slice(0, MAX_TITLE_LENGTH);
  const checkRuns = [
    checkRun({ id: 1, at: T2, name: 'codex-review', status: 'completed', conclusion: 'failure', title }),
    checkRun({ id: 2, at: T2, name: 'internal-review', status: 'completed', conclusion: 'failure', title }),
  ];
  const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[]], checkRuns });
  github.rest.pulls.listReviews = async () => {
    throw new Error(raw);
  };
  await assert.rejects(gate.run({ github, context: commentEvent, core: fakeCore().core }), /reviews API down/);
  assert.deepEqual(created, []);
});

test('run: failing to post the failed check run does not mask the crash that caused it', async () => {
  const { github } = fakeGithub({ prs: [openPr()], commentsByCall: [[]] });
  github.rest.pulls.listReviews = async () => {
    throw new Error('reviews API down');
  };
  github.rest.checks.create = async () => {
    throw new Error('checks API down');
  };
  const { core, log } = fakeCore();
  await assert.rejects(gate.run({ github, context: pushEvent, core }), /reviews API down/);
  assert.equal(log.errors.length, 2);
});

test('run: the sweep evaluates every open PR and one failure does not starve the rest', async () => {
  const { github, created } = fakeGithub({ prs: [openPr(7), openPr(8)], commentsByCall: [[]], failFor: [7] });
  const { core, log } = fakeCore();
  await gate.run({ github, context: ctx('schedule', {}), core });
  assert.ok(created.length > 0, 'PR 8 was still evaluated');
  assert.equal(log.failed.length, 1);
  assert.match(log.failed[0], /#7/);
  assert.equal(log.errors.length, 1);
  assert.match(log.errors[0], /pr-gate\.test\.js/, 'the stack, not just the message');
});

// The shape of a real release PR: the package's own version moved up, and a
// pin of it moved with it.
const modified = (filename, patch) => ({ filename, status: 'modified', patch });
const PYPROJECT = (version) =>
  `[build-system]\nrequires = ["setuptools"]\n\n[project]\nname = "validator"\nversion = "${version}"\n` +
  `dependencies = [\n    "contract-models==${version}",\n]\n`;
const RELEASE_FILES = [
  modified(
    'packages/validator/pyproject.toml',
    '@@ -5,7 +5,7 @@ requires = ["setuptools"]\n name = "validator"\n-version = "1.0.0rc25"\n+version = "1.0.0rc26"\n dependencies = [\n' +
      '-    "contract-models==1.0.0rc25",\n+    "contract-models==1.0.0rc26",\n ]\n',
  ),
  modified(
    'agents/validator.md',
    "@@ -46,8 +46,8 @@ on first use\n-{ check '1.0.0rc25' \\\n-  || pip install \"validator==1.0.0rc25\"; } \\\n+{ check '1.0.0rc26' \\\n+  || pip install \"validator==1.0.0rc26\"; } \\\n && run\n",
  ),
];
const RELEASE_MANIFESTS = {
  'packages/validator/pyproject.toml': { base: PYPROJECT('1.0.0rc25'), head: PYPROJECT('1.0.0rc26') },
};
const RELEASE = { from: '1.0.0rc25', to: '1.0.0rc26' };

// versionOnlyRelease reads a manifest through `read(side, path)`; this one
// serves `manifests[path][side]` and fails like a missing file otherwise.
const release = (files, manifests = RELEASE_MANIFESTS) =>
  gate.versionOnlyRelease({
    files,
    read: async (side, path) => {
      const text = manifests[path]?.[side];
      if (text === undefined) throw apiError(404);
      return text;
    },
  });
// The release plus one more file, which uses the release's own pair so that
// only the rule a case names can reject it.
const releaseWith = (patch, filename = 'extra.py') => [...RELEASE_FILES, modified(filename, patch)];
// A PR that moves nothing but the version line of a pyproject.toml.
const declared = (from, to, filename = 'pyproject.toml') =>
  modified(filename, `@@ -1 +1 @@\n-version = "${from}"\n+version = "${to}"\n`);
const bump = (from, to) =>
  release([declared(from, to)], { 'pyproject.toml': { base: PYPROJECT(from), head: PYPROJECT(to) } });

test('versionOnlyRelease: the own version moved up, with a pin of it, qualifies', async () => {
  assert.deepEqual(await release(RELEASE_FILES), RELEASE);
});

test('versionOnlyRelease: a line that keeps an unchanged version beside the bumped one still qualifies', async () => {
  assert.deepEqual(await release(releaseWith('@@ -1 +1 @@\n-a = "2.0.0" b = "1.0.0rc25"\n+a = "2.0.0" b = "1.0.0rc26"\n')), RELEASE);
});

test('versionOnlyRelease: the version of a [tool.poetry] package is its own version', async () => {
  const poetry = (v) => `[tool.poetry]\nname = "analitiq-cdk"\nversion = "${v}"\n`;
  const files = [declared('0.3.0', '0.4.0', 'cdk/pyproject.toml')];
  assert.deepEqual(await release(files, { 'cdk/pyproject.toml': { base: poetry('0.3.0'), head: poetry('0.4.0') } }), {
    from: '0.3.0',
    to: '0.4.0',
  });
});

test('versionOnlyRelease: the top-level version of a package.json is its own version', async () => {
  const pkg = (v) => JSON.stringify({ name: 'web', version: v }, null, 2);
  const file = modified('web/package.json', '@@ -3 +3 @@\n-  "version": "1.2.3"\n+  "version": "1.2.4"\n');
  assert.deepEqual(await release([file], { 'web/package.json': { base: pkg('1.2.3'), head: pkg('1.2.4') } }), {
    from: '1.2.3',
    to: '1.2.4',
  });
});

test('versionOnlyRelease: a PR with no files does not qualify', async () => {
  assert.equal(await release([]), null);
});

for (const status of ['added', 'removed', 'renamed', 'copied', 'changed']) {
  test(`versionOnlyRelease: a ${status} file disqualifies`, async () => {
    assert.equal(await release([...RELEASE_FILES, { ...RELEASE_FILES[1], filename: 'x', status }]), null);
  });
}

test('versionOnlyRelease: a file without a text patch (binary or too large) disqualifies', async () => {
  assert.equal(await release([...RELEASE_FILES, { filename: 'x.bin', status: 'modified' }]), null);
});

const DISQUALIFYING_EXTRA = {
  'an added line with no removed partner': '@@ -1,1 +1,2 @@\n-v = "1.0.0rc25"\n+v = "1.0.0rc26"\n+evil()\n',
  'a removed line with no added partner': '@@ -1,2 +1,1 @@\n-v = "1.0.0rc25"\n-guard()\n+v = "1.0.0rc26"\n',
  'a removed line paired with an added line across context': '@@ -1,3 +1,3 @@\n-v = "1.0.0rc25"\n guard()\n+v = "1.0.0rc26"\n',
  'an edit beside the version': '@@ -1 +1 @@\n-v = "1.0.0rc25"  # a\n+v = "1.0.0rc26"  # b\n',
  'a line changed without any version': '@@ -1 +1 @@\n-x = 1\n+x = 2\n',
  'a second version pair': '@@ -1 +1 @@\n-dep==2.0.0\n+dep==2.0.1\n',
  'the version glued to a leading word character': '@@ -1 +1 @@\n-v = "a1.0.0rc25"\n+v = "a1.0.0rc26"\n',
  'the version glued to a trailing extension': '@@ -1 +1 @@\n-v = "1.0.0rc25.tar"\n+v = "1.0.0rc26.tar"\n',
  'a no-newline marker': '@@ -1 +1 @@\n-v = "1.0.0rc25"\n\\ No newline at end of file\n+v = "1.0.0rc26"\n\\ No newline at end of file\n',
};
for (const [what, patch] of Object.entries(DISQUALIFYING_EXTRA)) {
  test(`versionOnlyRelease: ${what} disqualifies`, async () => {
    assert.equal(await release(releaseWith(patch)), null);
  });
}

test('versionOnlyRelease: pins moved without the own version do not qualify', async () => {
  assert.equal(await release([RELEASE_FILES[1]]), null);
  const dependency = modified('pyproject.toml', '@@ -1 +1 @@\n-    "requests==2.31.0",\n+    "requests==2.32.0",\n');
  assert.equal(await release([dependency], { 'pyproject.toml': { base: PYPROJECT('1.0.0'), head: PYPROJECT('1.0.0') } }), null);
});

test('versionOnlyRelease: a version line in a Poetry dependency sub-table is not the own version', async () => {
  const poetry = (dep) =>
    `[tool.poetry]\nname = "x"\nversion = "1.0.0"\n\n[tool.poetry.dependencies.requests]\nversion = "${dep}"\n`;
  const files = [declared('2.31.0', '2.32.0')];
  assert.equal(await release(files, { 'pyproject.toml': { base: poetry('2.31.0'), head: poetry('2.32.0') } }), null);
});

test('versionOnlyRelease: a dependency pinned at the own version and moved alone is not a release', async () => {
  const poetry = (dep) =>
    `[tool.poetry]\nname = "x"\nversion = "2.31.0"\n\n[tool.poetry.dependencies.requests]\nversion = "${dep}"\n`;
  const files = [declared('2.31.0', '2.32.0')];
  assert.equal(await release(files, { 'pyproject.toml': { base: poetry('2.31.0'), head: poetry('2.32.0') } }), null);
});

test('versionOnlyRelease: a nested "version" key in a package.json is not the own version', async () => {
  const pkg = (dep) => JSON.stringify({ name: 'web', version: '9.0.0', dependencies: { x: { version: dep } } }, null, 2);
  const file = modified('package.json', '@@ -6 +6 @@\n-        "version": "1.2.3"\n+        "version": "1.2.4"\n');
  assert.equal(await release([file], { 'package.json': { base: pkg('1.2.3'), head: pkg('1.2.4') } }), null);
});

test('versionOnlyRelease: a package.json that does not parse holds no own version', async () => {
  const file = modified('package.json', '@@ -3 +3 @@\n-  "version": "1.2.3"\n+  "version": "1.2.4"\n');
  const broken = (v) => `{ "version": "${v}", }`;
  assert.equal(await release([file], { 'package.json': { base: broken('1.2.3'), head: broken('1.2.4') } }), null);
});

test('versionOnlyRelease: a version line outside pyproject.toml or package.json is not the own version', async () => {
  assert.equal(await release([declared('1.0.0', '1.0.1', 'scripts/pins.py')]), null);
});

test('versionOnlyRelease: a version with a fourth dotted part is not a version', async () => {
  assert.equal(await bump('1.0.0.1', '1.0.0.2'), null);
});

test('versionOnlyRelease: a line replaced by itself is not a bump', async () => {
  assert.equal(await bump('1.0.0', '1.0.0'), null);
});

test('versionOnlyRelease: only a move to a greater version qualifies', async () => {
  for (const [from, to] of [
    ['1.0.0rc25', '1.0.0rc26'],
    ['1.0.0rc26', '1.0.0'],
    ['1.9.0', '1.10.0'],
    ['1.0.9', '1.1.0'],
    ['1.2.3-beta1', '1.2.3-beta2'],
    ['1.0.0dev1', '1.0.0'],
  ]) {
    assert.deepEqual(await bump(from, to), { from, to }, `${from} -> ${to}`);
  }
  for (const [from, to] of [
    ['1.0.1', '1.0.0'],
    ['1.0.0rc26', '1.0.0rc25'],
    ['1.0.0', '1.0.0rc26'],
    ['1.10.0', '1.9.0'],
  ]) {
    assert.equal(await bump(from, to), null, `${from} -> ${to}`);
  }
});

test('versionOnlyRelease: pre-releases with different labels are not comparable', async () => {
  assert.equal(await bump('1.0.0a1', '1.0.0rc1'), null);
});

test('versionOnlyRelease: a suffix that is not a pre-release label is not part of a version', async () => {
  assert.equal(await bump('1.0.0post1', '1.0.0'), null);
});

test('versionOnlyRelease: a pre-release label without its number is not part of a version', async () => {
  assert.equal(await bump('1.0.0-beta', '1.0.0-beta1'), null);
});

// The fake serves manifests by ref: the merge base the comparison names, and the head.
const servedManifests = Object.fromEntries(
  Object.entries(RELEASE_MANIFESTS).map(([path, { base, head }]) => [path, { [MERGE_BASE]: base, [HEAD]: head }]),
);
const releasePr = (changed_files = RELEASE_FILES.length) => ({ ...openPr(), changed_files });
const releaseRun = (given = {}) =>
  fakeGithub({ prs: [releasePr()], commentsByCall: [[]], files: RELEASE_FILES, manifests: servedManifests, ...given });

test('run: a version-only release PR passes both check runs without any review', async () => {
  const { github, created } = releaseRun();
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  const expected = 'version-only release: 1.0.0rc25 → 1.0.0rc26';
  assert.deepEqual(
    verdicts(created).map(([name, , status, conclusion, title]) => [name, status, conclusion, title]),
    [
      ['codex-review', 'completed', 'success', expected],
      ['internal-review', 'completed', 'success', expected],
    ],
  );
});

test('run: the diff judged is the one between the base and exactly the head the check runs go on', async () => {
  const { github, compared, read } = releaseRun();
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual([...new Set(compared)], [`${BASE}...${HEAD}`]);
  assert.deepEqual(
    [...new Set(read)].sort(),
    [`packages/validator/pyproject.toml@${HEAD}`, `packages/validator/pyproject.toml@${MERGE_BASE}`].sort(),
  );
});

test('run: a diff GitHub returned only part of is gated like any PR', async () => {
  const { github, created } = releaseRun({ prs: [releasePr(RELEASE_FILES.length + 1)] });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(created.map(stateOf), ['pending', 'pending']);
});

test('run: a PR changing more files than a comparison can list is never compared', async () => {
  const { github, created, compared } = releaseRun({ prs: [releasePr(301)] });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(compared, []);
  assert.deepEqual(created.map(stateOf), ['pending', 'pending']);
});

test('run: a failed read for the release check falls through to the reviews, and says so', async () => {
  const { github, created } = releaseRun({
    prs: [releasePr()],
    commentsByCall: [[comment(CODEX, CLEAN(HEAD), T1), comment(BOT, ATTEST(HEAD), T1)]],
    compareFails: apiError(502),
  });
  const { core, log } = fakeCore();
  await gate.run({ github, context: pushEvent, core });
  assert.deepEqual(created.map(stateOf), ['success', 'success']);
  assert.match(of(created, 'codex-review')[0].output.title, /Codex found no major issues/);
  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0], /#7.*HTTP 502/);
});

test('run: a missing manifest falls through to the reviews', async () => {
  const { github, created } = releaseRun({ manifests: {} });
  const { core, log } = fakeCore();
  await gate.run({ github, context: pushEvent, core });
  assert.deepEqual(created.map(stateOf), ['pending', 'pending']);
  assert.match(log.warnings[0], /HTTP 404/);
});

test('run: a manifest GitHub sends without content holds no own version', async () => {
  const { github, created } = releaseRun();
  github.rest.repos.getContent = async () => ({ data: { type: 'file', encoding: 'none', content: '' } });
  const { core, log } = fakeCore();
  await gate.run({ github, context: pushEvent, core });
  assert.deepEqual(created.map(stateOf), ['pending', 'pending']);
  assert.deepEqual(log.warnings, []);
});

test('run: an error that is not a failed request still crashes the gate', async () => {
  const { github, created } = releaseRun({ compareFails: new TypeError('bug') });
  await assert.rejects(gate.run({ github, context: pushEvent, core: fakeCore().core }), /bug/);
  assert.deepEqual([...new Set(created.map(stateOf))], ['error']);
});

test('run: a release PR carrying any other change is gated like any PR', async () => {
  const files = releaseWith('@@ -1 +1 @@\n-x = 1\n+x = 2\n');
  const { github, created } = releaseRun({ prs: [{ ...openPr(), changed_files: files.length }], files });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(created.map(stateOf), ['pending', 'pending']);
});

// ------------------------------------------------------------------ check runs

// The App's own slug, matching GATE_APP_SLUG in pr-gate.js.
const GATE_APP = 'analitiq-pr-gate';
const checkRun = ({ id, at, name, status, conclusion, title, slug = GATE_APP }) => ({
  id,
  name,
  head_sha: HEAD,
  status,
  conclusion: conclusion ?? null,
  started_at: at,
  output: { title },
  app: { slug },
});
const INTERNAL_CLEAN = `Internal review clean on ${HEAD10}`;
const WAITING_CODEX = `Waiting for a Codex review of ${HEAD10}`;
// What a posted run says, as [name, head_sha, status, conclusion, title], sorted by name.
const verdicts = (created) =>
  created
    .map((r) => [r.name, r.head_sha, r.status, r.conclusion, r.output?.title])
    .sort(([a], [b]) => a.localeCompare(b));
const assertTitlesFit = (created) =>
  created.forEach((r) => assert.ok(r.output.title.length <= 255, `title over 255 characters: ${r.output.title}`));

test('check runs: a clean verdict is posted as a completed, successful run titled with the verdict', async () => {
  const { github, created, posted } = fakeGithub({
    prs: [openPr()],
    commentsByCall: [[comment(CODEX, CLEAN(HEAD), T1), comment(BOT, ATTEST(HEAD), T1)]],
  });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(verdicts(created), [
    ['codex-review', HEAD, 'completed', 'success', CLEAN_DESCRIPTION],
    ['internal-review', HEAD, 'completed', 'success', INTERNAL_CLEAN],
  ]);
  assertTitlesFit(created);
  assert.deepEqual(posted, []);
});

test('check runs: a waiver is posted as a completed, successful run titled WAIVED', async () => {
  const { github, created, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(CODEX, LIMIT, T1)]] });
  await gate.run({ github, context: commentEvent, core: fakeCore().core });
  assert.deepEqual(verdicts(created).find(([name]) => name === 'codex-review'), [
    'codex-review',
    HEAD,
    'completed',
    'success',
    WAIVED_DESCRIPTION,
  ]);
  assertTitlesFit(created);
  assert.deepEqual(posted, []);
});

test('check runs: a version-only release is posted as completed, successful runs titled with the bump', async () => {
  const { github, created, posted } = releaseRun();
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  const bump = 'version-only release: 1.0.0rc25 → 1.0.0rc26';
  assert.deepEqual(verdicts(created), [
    ['codex-review', HEAD, 'completed', 'success', bump],
    ['internal-review', HEAD, 'completed', 'success', bump],
  ]);
  assert.deepEqual(posted, []);
});

test('check runs: a pending verdict is an in-progress run with no conclusion, titled with what is missing', async () => {
  const { github, created, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[]] });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(verdicts(created), [
    ['codex-review', HEAD, 'in_progress', undefined, WAITING_CODEX],
    ['internal-review', HEAD, 'in_progress', undefined, WAITING_INTERNAL],
  ]);
  assertTitlesFit(created);
  assert.deepEqual(posted, []);
});

test('check runs: a crash is a completed, failed run on both names, titled with the error and within 255 characters', async () => {
  const { github, created, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[]] });
  github.rest.pulls.listReviews = async () => {
    throw new Error(`reviews API down ${'x'.repeat(400)}`);
  };
  await assert.rejects(gate.run({ github, context: pushEvent, core: fakeCore().core }), /reviews API down/);
  assert.deepEqual(
    verdicts(created).map(([name, sha, status, conclusion]) => [name, sha, status, conclusion]),
    [
      ['codex-review', HEAD, 'completed', 'failure'],
      ['internal-review', HEAD, 'completed', 'failure'],
    ],
  );
  assert.ok(created.every((r) => /reviews API down/.test(r.output.title)));
  assertTitlesFit(created);
  assert.deepEqual(posted, []);
});

test('check runs: the history compared against is the App\'s own runs on the head, never commit statuses', async () => {
  const { github, created, checkRunReads, statusReads } = fakeGithub({
    prs: [openPr()],
    commentsByCall: [[comment(CODEX, CLEAN(HEAD), T1), comment(BOT, ATTEST(HEAD), T1)]],
    checkRuns: [
      checkRun({ id: 1, at: T2, name: 'codex-review', status: 'completed', conclusion: 'success', title: CLEAN_DESCRIPTION }),
      checkRun({ id: 2, at: T2, name: 'internal-review', status: 'completed', conclusion: 'success', title: INTERNAL_CLEAN }),
    ],
  });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(created, [], 'an unchanged verdict is not re-posted');
  assert.ok(checkRunReads.length > 0, 'the head\'s check runs were never read');
  assert.ok(checkRunReads.every((ref) => ref === HEAD));
  assert.deepEqual(statusReads, []);
});

test('check runs: a same-name run from another app is not the gate\'s history', async () => {
  const { github, created } = fakeGithub({
    prs: [openPr()],
    commentsByCall: [[comment(CODEX, CLEAN(HEAD), T1), comment(BOT, ATTEST(HEAD), T1)]],
    checkRuns: [
      checkRun({ id: 1, at: T2, name: 'codex-review', status: 'completed', conclusion: 'success', title: CLEAN_DESCRIPTION, slug: 'github-actions' }),
      checkRun({ id: 2, at: T2, name: 'internal-review', status: 'completed', conclusion: 'success', title: INTERNAL_CLEAN, slug: 'github-actions' }),
    ],
  });
  await gate.run({ github, context: pushEvent, core: fakeCore().core });
  assert.deepEqual(verdicts(created), [
    ['codex-review', HEAD, 'completed', 'success', CLEAN_DESCRIPTION],
    ['internal-review', HEAD, 'completed', 'success', INTERNAL_CLEAN],
  ]);
});

test('check runs: the App\'s newest run of a name is the one compared against, whatever order they are listed in', async () => {
  const older = checkRun({ id: 1, at: T0, name: 'codex-review', status: 'in_progress', title: WAITING_CODEX });
  const newer = checkRun({ id: 2, at: T2, name: 'codex-review', status: 'completed', conclusion: 'success', title: CLEAN_DESCRIPTION });
  for (const checkRuns of [[newer, older], [older, newer]]) {
    const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[]], checkRuns });
    await gate.run({ github, context: commentEvent, core: fakeCore().core });
    assert.deepEqual(
      verdicts(created).filter(([name]) => name === 'codex-review'),
      [['codex-review', HEAD, 'in_progress', undefined, WAITING_CODEX]],
      JSON.stringify(checkRuns.map((r) => r.id)),
    );
  }
});

test('run: an event that would run a branch\'s copy of the caller is refused before anything is read or posted', async () => {
  for (const eventName of ['pull_request', 'push', 'workflow_dispatch', 'pull_request_review', 'pull_request_review_comment', 'workflow_run']) {
    const { github, posted, created, checkRunReads, statusReads } = fakeGithub({ prs: [openPr()], commentsByCall: [[]] });
    const context = ctx(eventName, { pull_request: { number: 7, head: { sha: HEAD } } });
    await assert.rejects(gate.run({ github, context, core: fakeCore().core }), new RegExp(`\\b${eventName}\\b`), eventName);
    assert.deepEqual([posted, created, checkRunReads, statusReads], [[], [], [], []], eventName);
  }
});

test('run: checks.create answering as a different App surfaces as an error naming that slug', async () => {
  const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(CODEX, CLEAN(HEAD), T1)]] });
  github.rest.checks.create = async (run) => {
    created.push(run);
    return { data: { id: 1000 + created.length, app: { slug: 'some-imposter-app' } } };
  };
  await assert.rejects(gate.run({ github, context: pushEvent, core: fakeCore().core }), /some-imposter-app/);
});

test('check runs: two same-named runs with an equal started_at are tied by id, the higher one newest', async () => {
  const lowerId = checkRun({ id: 1, at: T2, name: 'codex-review', status: 'in_progress', title: WAITING_CODEX });
  const higherId = checkRun({ id: 2, at: T2, name: 'codex-review', status: 'completed', conclusion: 'success', title: CLEAN_DESCRIPTION });
  for (const checkRuns of [[lowerId, higherId], [higherId, lowerId]]) {
    const { github, created } = fakeGithub({ prs: [openPr()], commentsByCall: [[]], checkRuns });
    await gate.run({ github, context: commentEvent, core: fakeCore().core });
    assert.deepEqual(
      verdicts(created).filter(([name]) => name === 'codex-review'),
      [['codex-review', HEAD, 'in_progress', undefined, WAITING_CODEX]],
      JSON.stringify(checkRuns.map((r) => r.id)),
    );
  }
});
