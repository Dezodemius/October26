'use strict';

const STATE_BRANCH = 'issue-numbering-state';
const STATE_FILE = 'issue-numbers.json';
const PREFIX = /^(?:\[(?:BUG|FEAT)(?:-\d+)?\]\s*)+/i;

function classify(issue) {
  const labels = new Set(issue.labels.map(label => label.name.toLowerCase()));
  const bug = labels.has('bug');
  const feature = labels.has('enhancement');
  // Conflicting labels need triage; do not consume a number arbitrarily.
  if (bug && feature) return null;
  if (bug) return 'BUG';
  if (feature) return 'FEAT';
  return /^\[(BUG|FEAT)(?:-\d+)?\]/i.exec(issue.title)?.[1].toUpperCase() ?? null;
}

function validateState(state) {
  if (state.version !== 1 || !state.counters || !state.issues) {
    throw new Error('Invalid numbering state; refusing to reset counters');
  }
  const used = new Set();
  for (const prefix of ['BUG', 'FEAT']) {
    if (!Number.isSafeInteger(state.counters[prefix]) || state.counters[prefix] < 0) {
      throw new Error('Invalid numbering counter');
    }
  }
  for (const [issue, assignment] of Object.entries(state.issues)) {
    if (!/^[1-9]\d*$/.test(issue) || !assignment ||
        !['BUG', 'FEAT'].includes(assignment.prefix) ||
        !Number.isSafeInteger(assignment.number) || assignment.number < 1 ||
        assignment.number > state.counters[assignment.prefix]) {
      throw new Error('Invalid issue number assignment');
    }
    const key = `${assignment.prefix}-${assignment.number}`;
    if (used.has(key)) throw new Error('Duplicate issue number in state');
    used.add(key);
  }
}

async function readState(github, repo) {
  let head;
  try {
    head = (await github.rest.git.getRef({ ...repo, ref: `heads/${STATE_BRANCH}` })).data.object.sha;
  } catch (error) {
    if (error.status !== 404) throw error;
    return { head: null, state: { version: 1, counters: { BUG: 0, FEAT: 0 }, issues: {} } };
  }
  // Read by immutable SHA, not branch name: another run may advance it now.
  const { data } = await github.rest.repos.getContent({ ...repo, path: STATE_FILE, ref: head });
  if (data.encoding !== 'base64' || typeof data.content !== 'string') {
    throw new Error('Numbering state is not a readable JSON file');
  }
  const state = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  validateState(state);
  return { head, state };
}

async function reserve(github, repo, issueNumber, prefix, sleep) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const { head, state } = await readState(github, repo);
    const existing = state.issues[issueNumber];
    if (existing) return existing;
    if (!prefix) return null;
    const assignment = { prefix, number: state.counters[prefix] + 1 };
    state.counters[prefix] = assignment.number;
    state.issues[issueNumber] = assignment;
    validateState(state);
    const tree = await github.rest.git.createTree({
      ...repo,
      tree: [{ path: STATE_FILE, mode: '100644', type: 'blob', content: JSON.stringify(state, null, 2) + '\n' }],
    });
    const commit = await github.rest.git.createCommit({
      ...repo,
      message: `Assign ${prefix}-${assignment.number} to issue #${issueNumber}`,
      tree: tree.data.sha,
      parents: head ? [head] : [],
    });
    try {
      if (head) {
        // Sibling commits cannot fast-forward each other: only one writer wins.
        await github.rest.git.updateRef({
          ...repo, ref: `heads/${STATE_BRANCH}`, sha: commit.data.sha, force: false,
        });
      } else {
        await github.rest.git.createRef({ ...repo, ref: `refs/heads/${STATE_BRANCH}`, sha: commit.data.sha });
      }
      return assignment;
    } catch (error) {
      if (![409, 422].includes(error.status)) throw error;
      // Retry only if another writer actually advanced/created the branch.
      const latest = await github.rest.git.getRef({ ...repo, ref: `heads/${STATE_BRANCH}` });
      if (latest.data.object.sha === head) throw error;
      await sleep(100 + Math.floor(Math.random() * 400));
    }
  }
  throw new Error('Number allocation contention exceeded retry limit; rerun this workflow');
}

async function numberIssue({ github, context, core, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const repo = context.repo;
  const issueNumber = context.issue.number;
  const { data: issue } = await github.rest.issues.get({ ...repo, issue_number: issueNumber });
  if (issue.pull_request) return;
  const assignment = await reserve(github, repo, issueNumber, classify(issue), sleep);
  if (!assignment) {
    core.info('No unambiguous BUG/FEAT category; no number assigned');
    return;
  }
  // Allocation is durable before updating the title. A retry repairs a failed update.
  const { data: latest } = await github.rest.issues.get({ ...repo, issue_number: issueNumber });
  const code = `${assignment.prefix}-${String(assignment.number).padStart(4, '0')}`;
  const description = latest.title.replace(PREFIX, '').trim();
  // GitHub limits issue titles to 256 characters. Keep complete Unicode code points.
  const title = Array.from(`[${code}]${description ? ` ${description}` : ''}`).slice(0, 256).join('');
  if (title !== latest.title) {
    await github.rest.issues.update({ ...repo, issue_number: issueNumber, title });
  }
  core.info(`Issue #${issueNumber}: ${code}`);
}

module.exports = { numberIssue, classify, validateState };
