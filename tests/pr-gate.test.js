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

const BEFORE = '2025-12-31T23:00:00Z';
const T0 = '2026-01-01T00:00:00Z'; // the head was pushed
const T1 = '2026-01-01T00:05:00Z';
const T2 = '2026-01-01T00:10:00Z';
const T3 = '2026-01-01T00:15:00Z';

const codex = (given) =>
  gate.codexStatus({ comments: [], reviews: [], head: HEAD, headPushedAt: Date.parse(T0), ...given });
const internal = (comments) => gate.internalReviewStatus({ comments, head: HEAD });

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
function fakeGithub({ prs, commentsByCall, reviews = [], statuses = [], suites = [suite(T0)], failFor = [] }) {
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
    },
    checks: {
      listSuitesForRef: async () => ({ data: { total_count: suites.length, check_suites: suites } }),
    },
    repos: {
      // newest first, as the API returns them
      listCommitStatusesForRef: async () => ({ data: statuses }),
      createCommitStatus: async (s) => {
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
    [status('codex-review', 'error', 'pr-gate failed: x', T3), status('codex-review', 'success', WAIVED_DESCRIPTION, T2)],
  ]) {
    const { github, posted } = fakeGithub({ prs: [openPr()], commentsByCall: [[comment(CODEX, LIMIT, T1)]], statuses });
    await gate.run({ github, context: commentEvent, core: fakeCore().core });
    assert.equal(of(posted, 'codex-review')[0].description, WAIVED_DESCRIPTION);
  }
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
  // GitHub rejects descriptions over 140 characters.
  assert.ok(posted.every((s) => s.description.length <= 140 && s.sha === HEAD));
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
  const description = 'pr-gate failed: Error: reviews API down';
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
