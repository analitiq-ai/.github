'use strict';

// Turns two facts no GitHub check can observe on its own into App-signed check
// runs on a PR's head, so a ruleset can require them:
//
//   codex-review     Codex reviewed THIS commit and found nothing major.
//   internal-review  Analitiq-Bot attested a clean internal review of THIS
//                    commit (verifiable only as far as author + SHA).
//
// A version-only release PR (see versionOnlyRelease) passes both without
// either review; both runs then title "version-only release: OLD → NEW".
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

// This App's own slug. post() checks a freshly created run's response against
// it, so a caller running this script with a token from the wrong App fails
// loud instead of posting under a name a ruleset won't recognize; newestRun
// uses it only as the gate's own re-post dedup (see the README's Limits
// section for what actually stops a forged same-named run from another
// actor).
const GATE_APP_SLUG = 'analitiq-pr-gate';

const MAX_TITLE_LENGTH = 255;
// GitHub rejects a longer check-run title. The gate words its own successes,
// waivers and pendings to fit; an error's message is not its to word, so
// every title is capped here, at the one boundary they all cross.
const fitsTitle = (title) => title.slice(0, MAX_TITLE_LENGTH);

// The gate's wording around an error it did not write. Named so a test builds the
// crash text from here instead of keeping its own copy; what a crash posts is
// this, capped by fitsTitle.
const crashDescription = (error) => `pr-gate failed: ${error}`;

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
    return { pending: `Codex's thumbs-up is not counted: ${short(head)} has no check suite to date its push` };
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
    : { pending: `Codex's thumbs-up is not tied to ${short(head)}; comment @codex review` };
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
      return { state: 'success', description: latest.byThumbsUp ? `${found} (thumbs-up on the PR)` : found };
    }
    return {
      state: 'pending',
      description: `No clean Codex verdict for ${short(head)} yet`,
      notice: `Codex's newest verdict for ${short(head)} is not its clean template`,
    };
  }

  // The waiver only fills the absence of a verdict, and never while Codex shows
  // 👀: a review is running, and its answer, a verdict or a fresh
  // out-of-credits reply, is minutes away.
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

// Exactly x.y.z, so neither a float constant (0.5) nor an IP address
// (10.1.2.3) is a version, plus an optional pre-release suffix: a label PEP 440
// and semver both rank before the release, then its number (rc26, -beta1).
// Another suffix glued on (post1, beta) leaves no version token; after a hyphen
// (-post1, -beta) the token is the bare x.y.z and the suffix stays text, so the
// manifest's own version (1.0.0-post1) never equals it. Whole tokens only:
// neither `a1.0.0` nor `1.0.0rc25.tar` holds a version. The capture makes split() interleave text and versions,
// versions at the odd indices.
const VERSION = String.raw`\d+\.\d+\.\d+(?:-?(?:alpha|a|beta|b|rc|dev)\d+)?`;
const VERSION_TOKEN = new RegExp(String.raw`(?<![\w.])(${VERSION})(?![\w.])`);
const VERSION_PARTS = /^(\d+)\.(\d+)\.(\d+)(?:-?([a-z]+)(\d+))?$/;

// Whether `to` is a greater version than `from`. A release outranks its
// pre-releases; two pre-releases of one x.y.z are ordered only by number and
// only under the same label, because PEP 440 and semver order labels
// differently (PEP 440's `dev` precedes `a`).
function isGreater(to, from) {
  const [, ...next] = VERSION_PARTS.exec(to);
  const [, ...last] = VERSION_PARTS.exec(from);
  for (let i = 0; i < 3; i += 1) {
    if (Number(next[i]) !== Number(last[i])) return Number(next[i]) > Number(last[i]);
  }
  const [nextLabel, nextNumber] = next.slice(3);
  const [lastLabel, lastNumber] = last.slice(3);
  if (lastLabel === undefined) return false;
  if (nextLabel === undefined) return true;
  return nextLabel === lastLabel && Number(nextNumber) > Number(lastNumber);
}

// The version substitutions turning `removed` into `added`, or null when
// anything other than version tokens differs between them.
function lineSubstitutions(removed, added) {
  const before = removed.split(VERSION_TOKEN);
  const after = added.split(VERSION_TOKEN);
  if (before.length !== after.length) return null;
  const substitutions = [];
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] === after[i]) continue;
    if (i % 2 === 0) return null;
    substitutions.push(`${before[i]}\n${after[i]}`);
  }
  return substitutions;
}

// A patch's changed lines as [removed, added] pairs, or null when a hunk holds
// anything but removed lines each followed, in order, by its added replacement.
function replacedLines(patch) {
  const pairs = [];
  let removed = [];
  let added = [];
  const closeBlock = () => {
    if (removed.length !== added.length) return false;
    removed.forEach((line, i) => pairs.push([line, added[i]]));
    removed = [];
    added = [];
    return true;
  };
  for (const line of patch.split('\n')) {
    const kind = line[0];
    // A context line, a hunk header, or the patch's trailing newline.
    const boundary = kind === ' ' || kind === '@' || line === '';
    if ((boundary || (kind === '-' && added.length > 0)) && !closeBlock()) return null;
    if (kind === '-') {
      removed.push(line.slice(1));
    } else if (kind === '+') {
      added.push(line.slice(1));
    } else if (!boundary) {
      // '\ No newline at end of file', or anything else a patch should not hold
      return null;
    }
  }
  return closeBlock() ? pairs : null;
}

// The one version substitution a whole diff makes, or null when any file,
// hunk or line does anything else. A file-level change (added, removed,
// renamed) or a missing patch (binary, too large) disqualifies: the diff
// cannot be read in full.
function soleVersionChange(files) {
  const substitutions = new Set();
  for (const file of files) {
    if (file.status !== 'modified' || typeof file.patch !== 'string') return null;
    const pairs = replacedLines(file.patch);
    if (pairs === null) return null;
    for (const [removed, added] of pairs) {
      const found = lineSubstitutions(removed, added);
      if (found === null) return null;
      found.forEach((substitution) => substitutions.add(substitution));
    }
  }
  if (substitutions.size !== 1) return null;
  const [from, to] = [...substitutions][0].split('\n');
  return { from, to };
}

// The version a manifest declares for its own package, by file name, or null.
// Read from the manifest's structure, because a patch line cannot show which
// table or depth it sits in: a `version` under a Poetry dependency sub-table,
// or nested in package.json, is a pin, not the package's version.
const OWN_VERSION_READERS = {
  'package.json': (text) => {
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      return null; // not a manifest that declares anything
    }
    return typeof manifest?.version === 'string' ? manifest.version : null;
  },
  // Only [project] (PEP 621) and [tool.poetry] declare the package. A header
  // this does not parse ([[array]], quoted keys) leaves only the lines under it
  // unread; a later [project] or [tool.poetry] is still read.
  'pyproject.toml': (text) => {
    let table = null;
    for (const line of text.split('\n')) {
      if (/^\s*\[/.test(line)) {
        table = /^\s*\[([\w.]+)\]\s*(?:#.*)?$/.exec(line)?.[1] ?? null;
      } else if (table === 'project' || table === 'tool.poetry') {
        const declared = /^\s*version\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line);
        if (declared) return declared[1];
      }
    }
    return null;
  },
};
const ownVersionReader = (filename) => OWN_VERSION_READERS[filename.split('/').pop()];

// A PR whose whole diff moves its package's own version up, and any pins of it
// with it, changes nothing a reviewer could judge: what it releases was
// reviewed when it merged. Returns that bump, or null.
// read(side, path): a changed file's text at 'base' (the merge base) or 'head',
// or null when it cannot be read as text.
// read is called only for manifests, and only once the diff passed as one
// version change; the comparison that produced `files` is the caller's.
async function versionOnlyRelease({ files, read }) {
  const change = soleVersionChange(files);
  if (change === null || !isGreater(change.to, change.from)) return null;
  for (const { filename } of files) {
    const ownVersion = ownVersionReader(filename);
    if (ownVersion === undefined) continue;
    const declared = async (side) => {
      const text = await read(side, filename);
      return text === null ? null : ownVersion(text);
    };
    if ((await declared('base')) === change.from && (await declared('head')) === change.to) return change;
  }
  return null;
}

// A comparison lists at most this many files; a PR changing more can never be
// read in full, so it is not compared at all.
const MAX_COMPARED_FILES = 300;

// The version-only release pr.head.sha is, or null. Reads the diff for exactly
// that head, not the PR's file list, which follows the branch as it moves.
async function readRelease({ github, owner, repo, pr }) {
  if (!Number.isInteger(pr.changed_files)) {
    throw new Error(`pull request has no changed-file count: ${JSON.stringify(pr.changed_files)}`);
  }
  if (pr.changed_files === 0 || pr.changed_files > MAX_COMPARED_FILES) return null;
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${pr.base.sha}...${pr.head.sha}`,
  });
  const files = comparison.files ?? [];
  if (files.length !== pr.changed_files) return null;
  const refs = { base: comparison.merge_base_commit.sha, head: pr.head.sha };
  const read = async (side, path) => {
    const { data } = await github.rest.repos.getContent({ owner, repo, path, ref: refs[side] });
    // Over 1 MB GitHub sends no content; a manifest it will not show is none.
    if (data.type !== 'file' || data.encoding !== 'base64') return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  };
  return versionOnlyRelease({ files, read });
}

// The three states the gate's own logic ever returns. `conclusion` is absent
// for `pending`: a run still `in_progress` has none to report.
const CHECK_RUN_STATE = {
  success: { status: 'completed', conclusion: 'success' },
  error: { status: 'completed', conclusion: 'failure' },
  pending: { status: 'in_progress' },
};

// The App's own newest run of this name, or undefined. Check runs are not
// returned newest-first the way commit statuses were, so they are compared by
// when each started, with a tie broken by the higher id: GitHub hands out
// check-run ids monotonically, so two runs sharing a started_at are still
// ordered. A same-named run from another app is not this gate's history at
// all.
function newestRun(history, name) {
  return history
    .filter((run) => run.name === name && run.app?.slug === GATE_APP_SLUG)
    .reduce((latest, run) => {
      if (latest === undefined) return run;
      const runAt = timestamp(run.started_at, `check run ${run.id}`);
      const latestAt = timestamp(latest.started_at, `check run ${latest.id}`);
      if (runAt !== latestAt) return runAt > latestAt ? run : latest;
      return run.id > latest.id ? run : latest;
    }, undefined);
}

async function post({ github, core, owner, repo, pr, history, name, status, runUrl }) {
  const run = CHECK_RUN_STATE[status.state];
  if (run === undefined) throw new Error(`pr-gate produced an unknown state: ${JSON.stringify(status.state)}`);
  // Compared, posted and logged as the API will hold it, so an unchanged run
  // still reads as unchanged next run.
  const title = fitsTitle(status.description);
  const current = newestRun(history, name);
  if (current && current.status === run.status && (current.conclusion ?? undefined) === run.conclusion && current.output?.title === title) {
    core.info(`PR #${pr.number} @ ${short(pr.head.sha)}: ${name} already ${status.state}`);
    return;
  }
  const { data } = await github.rest.checks.create({
    owner,
    repo,
    name,
    head_sha: pr.head.sha,
    details_url: runUrl,
    output: { title, summary: status.description },
    ...run,
  });
  // Whatever the token's owner meant to be, the run it just created belongs to
  // whichever App the token actually authenticated as; a caller running this
  // script with the wrong token would otherwise post a run silently ignored
  // by any ruleset that requires the real App.
  if (data.app?.slug !== GATE_APP_SLUG) {
    throw new Error(`checks.create posted as '${data.app?.slug}', not the ${GATE_APP_SLUG} App`);
  }
  core.info(`PR #${pr.number} @ ${short(pr.head.sha)}: ${name} -> ${status.state} (${title})`);
}

async function readStatuses({ github, core, owner, repo, pr }) {
  const head = pr.head.sha;
  // The exemption only ever adds a way to pass: a request it makes failing
  // leaves the PR to its reviews, never to an error status they would clear.
  let release = null;
  try {
    release = await readRelease({ github, owner, repo, pr });
  } catch (error) {
    if (typeof error?.status !== 'number') throw error;
    core.warning(`PR #${pr.number}: version-only release check skipped: ${error}`);
  }
  if (release !== null) {
    const status = { state: 'success', description: `version-only release: ${release.from} → ${release.to}` };
    return { [CODEX_CONTEXT]: status, [INTERNAL_CONTEXT]: status };
  }

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

async function evaluateHead({ github, core, owner, repo, pr, history, runUrl }) {
  let wanted = await readStatuses({ github, core, owner, repo, pr });

  // Runs are last-writer-wins, and the sweep runs outside the per-PR
  // concurrency group. A run working from a snapshot taken before a verdict
  // landed would overwrite a newer success (or race past it on a brand-new
  // head), so a demotion or a first pending is re-derived from a fresh read
  // right before posting. That narrows the race; it does not close it.
  const aboutToDemote = Object.entries(wanted).some(([name, status]) => {
    const current = newestRun(history, name);
    return status.state !== 'success' && (!current || current.conclusion === 'success');
  });
  if (aboutToDemote) {
    wanted = await readStatuses({ github, core, owner, repo, pr });
  }

  for (const [name, status] of Object.entries(wanted)) {
    if (status.notice) core.notice(`PR #${pr.number}: ${status.notice}`);
    await post({ github, core, owner, repo, pr, history, name, status, runUrl });
  }
}

async function evaluate({ github, core, owner, repo, prNumber, runUrl }) {
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (pr.state !== 'open') {
    core.info(`PR #${prNumber} is ${pr.state}; nothing to gate`);
    return;
  }

  let history = [];
  try {
    // The App's own check runs on this head are what newestRun compares
    // against; the app.slug filter that keeps another actor's same-named run
    // out of that comparison lives there, next to the comparison it decides.
    history = await github.paginate(github.rest.checks.listForRef, {
      owner,
      repo,
      ref: pr.head.sha,
      per_page: 100,
    });
    await evaluateHead({ github, core, owner, repo, pr, history, runUrl });
  } catch (error) {
    // Surface the crash on the PR itself: a run that dies here is otherwise
    // visible only in the Actions tab, and the author would read the stuck
    // gate as "the reviewer is slow". The error state still blocks merge. Both
    // names: they are derived together, so after a failure neither is known
    // to be current.
    const status = { state: 'error', description: crashDescription(error) };
    for (const name of [CODEX_CONTEXT, INTERNAL_CONTEXT]) {
      try {
        await post({ github, core, owner, repo, pr, history, name, status, runUrl });
      } catch (postError) {
        core.error(`PR #${prNumber}: could not post ${name} check run: ${postError.stack || postError}`);
      }
    }
    throw error;
  }
}

// The four events that run this workflow file from the default branch (see
// "Wiring it into a consumer repo" in the README). Anything else would run a
// branch's copy of the caller with its write token; refusing here cannot
// prevent that, but makes a consumer who wires such a trigger by mistake fail
// on the first run.
const ALLOWED_EVENTS = ['pull_request_target', 'issue_comment', 'schedule', 'repository_dispatch'];

// Entry point for the shared composite action. The schedule's sweep is the
// retry net for event runs that failed or were never delivered, and the only
// trigger guaranteed to follow a verdict delivered as a PR review, since
// review events must never trigger this. A repository_dispatch sweeps too: a
// reaction triggers nothing, so whoever sees Codex's 👍 dispatches one rather
// than wait for the next scheduled sweep.
async function run({ github, context, core }) {
  if (!ALLOWED_EVENTS.includes(context.eventName)) {
    throw new Error(`pr-gate must not be triggered by '${context.eventName}'`);
  }

  const { owner, repo } = context.repo;
  const { pull_request: pullRequest, issue } = context.payload;
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;

  if (pullRequest) {
    await evaluate({ github, core, owner, repo, prNumber: pullRequest.number, runUrl });
    return;
  }
  if (issue) {
    if (issue.pull_request) {
      await evaluate({ github, core, owner, repo, prNumber: issue.number, runUrl });
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
      await evaluate({ github, core, owner, repo, prNumber: pr.number, runUrl });
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

module.exports = {
  codexStatus,
  crashDescription,
  internalReviewStatus,
  versionOnlyRelease,
  run,
};
