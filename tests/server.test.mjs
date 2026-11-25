import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createGitHubClient } from '../src/github.mjs';
import { createTools, extractFileDiff, prepareArgs, tailLines } from '../src/tools.mjs';
import { handleRpcMessage, SERVER_INFO } from '../src/server.mjs';

const TOKEN = 'ghp_serverTestToken0123456789';
const API = 'https://api.test.local';
const SERVER_PATH = fileURLToPath(new URL('../src/server.mjs', import.meta.url));

const EXPECTED_TOOLS = [
  'github_whoami',
  'github_get_repo',
  'github_list_issues',
  'github_get_issue',
  'github_create_issue',
  'github_comment_issue',
  'github_list_prs',
  'github_get_pr',
  'github_get_pr_diff',
  'github_create_pr',
  'github_review_pr',
  'github_list_workflow_runs',
  'github_get_workflow_logs',
  'github_rerun_workflow',
  'github_search_code',
  'github_create_release',
];

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

const ok = (data, status = 200) => () => jsonResponse(data, status);

// Route-based fetch mock keyed by "METHOD /path". Values are response factories.
function setup(routes = {}, { defaultCwd = () => '/work' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method || 'GET';
    calls.push({ url: String(url), host: parsed.host, path: parsed.pathname, query: parsed.searchParams, method, init });
    const handler = routes[`${method} ${parsed.pathname}`];
    if (!handler) throw new Error(`no mock route for ${method} ${parsed.pathname}`);
    return handler(parsed, init);
  };
  const client = createGitHubClient({
    fetchImpl,
    tokenResolver: async () => TOKEN,
    apiUrl: API,
    repoResolver: async ({ owner, repo, cwd }) => {
      if (owner && repo) return { owner, repo };
      assert.ok(cwd, 'repo resolver needs a cwd');
      return { owner: 'acme', repo: 'app' };
    },
  });
  const tools = createTools(client, { defaultCwd });
  return { calls, tools };
}

async function rpc(msg, tools) {
  return handleRpcMessage(msg, { tools });
}

async function callTool(tools, name, args = {}) {
  const res = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, tools);
  assert.equal(res.id, 7);
  assert.ok(res.result, `expected a result, got ${JSON.stringify(res)}`);
  const text = res.result.content[0].text;
  assert.ok(!text.includes(TOKEN), 'tool output leaked the token');
  return { result: res.result, text, isError: res.result.isError === true };
}

const parse = (text) => JSON.parse(text);

describe('JSON-RPC protocol', () => {
  const { tools } = setup();

  test('initialize echoes a supported protocol version', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, tools);
    assert.deepEqual(res, {
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: SERVER_INFO },
    });
  });

  test('initialize falls back to 2024-11-05 for unknown versions', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, tools);
    assert.equal(res.result.protocolVersion, '2024-11-05');
    assert.deepEqual(res.result.serverInfo, { name: 'github-kit', version: '1.0.0' });
  });

  test('notifications get no response', async () => {
    assert.equal(await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools), null);
    assert.equal(await rpc({ jsonrpc: '2.0', method: 'notifications/unknown' }, tools), null);
  });

  test('ping returns an empty object', async () => {
    assert.deepEqual(await rpc({ jsonrpc: '2.0', id: 'p', method: 'ping' }, tools), { jsonrpc: '2.0', id: 'p', result: {} });
  });

  test('unknown methods return -32601', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, tools);
    assert.equal(res.error.code, -32601);
  });

  test('invalid requests return -32600', async () => {
    assert.equal((await rpc({ jsonrpc: '2.0', id: 4 }, tools)).error.code, -32600);
    assert.equal((await rpc(42, tools)).error.code, -32600);
    assert.equal((await rpc([], tools)).error.code, -32600);
  });

  test('batches return only responses for requests', async () => {
    const res = await rpc(
      [
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ],
      tools,
    );
    assert.deepEqual(res, [{ jsonrpc: '2.0', id: 1, result: {} }]);
  });

  test('tools/call with an unknown tool returns -32602', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } }, tools);
    assert.equal(res.error.code, -32602);
    assert.match(res.error.message, /Unknown tool: nope/);
  });
});

describe('tools/list', () => {
  const { tools } = setup();

  test('exposes the 16 tools with valid schemas', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, tools);
    const listed = res.result.tools;
    assert.deepEqual(
      listed.map((t) => t.name),
      EXPECTED_TOOLS,
    );
    for (const tool of listed) {
      assert.deepEqual(Object.keys(tool).sort(), ['description', 'inputSchema', 'name']);
      assert.match(tool.name, /^[a-z0-9_]+$/);
      assert.ok(tool.description.length > 20, `${tool.name} needs a description`);
      assert.ok(!tool.description.includes(String.fromCharCode(0x2014)), `${tool.name} has an em-dash`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(typeof tool.inputSchema.properties, 'object');
      for (const key of tool.inputSchema.required) {
        assert.ok(key in tool.inputSchema.properties, `${tool.name}: required "${key}" is not a property`);
      }
      for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
        assert.ok(prop.type, `${tool.name}.${key} has no type`);
        assert.ok(prop.description, `${tool.name}.${key} has no description`);
      }
    }
  });
});

describe('argument handling', () => {
  test('applies defaults and coerces numeric strings', () => {
    const schema = setup().tools.find((t) => t.name === 'github_get_issue').inputSchema;
    const { args, error } = prepareArgs(schema, { issue_number: '42' });
    assert.equal(error, null);
    assert.equal(args.issue_number, 42);
    assert.equal(args.include_comments, true);
  });

  test('reports missing and out of range arguments as tool errors', async () => {
    const { tools, calls } = setup();
    const missing = await callTool(tools, 'github_get_issue', {});
    assert.ok(missing.isError);
    assert.match(missing.text, /Missing required argument: issue_number/);

    const range = await callTool(tools, 'github_list_issues', { per_page: 500 });
    assert.ok(range.isError);
    assert.match(range.text, /per_page must be <= 50/);

    const badEnum = await callTool(tools, 'github_review_pr', { pull_number: 1, event: 'MERGE' });
    assert.match(badEnum.text, /event must be one of/);

    const nested = await callTool(tools, 'github_review_pr', {
      pull_number: 1,
      event: 'COMMENT',
      comments: [{ path: 'a.js', body: 'x' }],
    });
    assert.match(nested.text, /Missing required argument: comments\[0\]\.line/);
    assert.equal(calls.length, 0);
  });

  test('requires cwd or owner/repo when running inside the plugin directory', async () => {
    const { tools, calls } = setup({}, { defaultCwd: () => null });
    const res = await callTool(tools, 'github_get_repo', {});
    assert.ok(res.isError);
    assert.match(res.text, /Pass cwd .* or owner and repo/);
    assert.equal(calls.length, 0);
  });
});

describe('read tools', () => {
  test('github_whoami combines user and rate limits', async () => {
    const { tools } = setup({
      'GET /user': ok({ login: 'octo', name: 'Octo Cat', plan: { name: 'pro' }, html_url: 'https://github.com/octo' }),
      'GET /rate_limit': ok({
        resources: {
          core: { limit: 5000, remaining: 4990, reset: 1893456000 },
          search: { limit: 30, remaining: 29, reset: 1893456000 },
        },
      }),
    });
    const out = parse((await callTool(tools, 'github_whoami')).text);
    assert.equal(out.login, 'octo');
    assert.equal(out.plan, 'pro');
    assert.deepEqual(out.rate_limit.core, { limit: 5000, remaining: 4990, reset: '2030-01-01T00:00:00.000Z' });
    assert.equal(out.rate_limit.search.remaining, 29);
  });

  test('github_get_repo uses explicit owner and repo', async () => {
    const { tools, calls } = setup({
      'GET /repos/octo/tools': ok({ full_name: 'octo/tools', default_branch: 'main', stargazers_count: 3, topics: ['cli'] }),
    });
    const out = parse((await callTool(tools, 'github_get_repo', { owner: 'octo', repo: 'tools' })).text);
    assert.equal(out.full_name, 'octo/tools');
    assert.equal(out.default_branch, 'main');
    assert.equal(out.stars, 3);
    assert.equal(calls[0].path, '/repos/octo/tools');
  });

  test('github_list_issues filters out pull requests and forwards filters', async () => {
    const { tools, calls } = setup({
      'GET /repos/acme/app/issues': ok([
        { number: 1, title: 'Bug', state: 'open', user: { login: 'a' }, labels: [{ name: 'bug' }], assignees: [] },
        { number: 2, title: 'PR', state: 'open', user: { login: 'b' }, pull_request: {} },
      ]),
    });
    const out = parse((await callTool(tools, 'github_list_issues', { labels: 'bug, ui', state: 'all' })).text);
    assert.equal(out.count, 1);
    assert.equal(out.issues[0].number, 1);
    assert.deepEqual(out.issues[0].labels, ['bug']);
    assert.equal(calls[0].query.get('labels'), 'bug,ui');
    assert.equal(calls[0].query.get('state'), 'all');
    assert.equal(calls[0].query.get('per_page'), '30');
  });

  test('github_get_issue returns the most recent comments', async () => {
    const comment = (n) => ({ user: { login: `u${n}` }, body: `comment ${n}`, created_at: 't', html_url: `c${n}` });
    const { tools, calls } = setup({
      'GET /repos/acme/app/issues/9': ok({ number: 9, title: 'Crash', state: 'open', comments: 25, user: { login: 'x' }, body: 'boom' }),
      'GET /repos/acme/app/issues/9/comments': (url) => {
        const page = Number(url.searchParams.get('page'));
        const items = page === 1 ? Array.from({ length: 20 }, (_, i) => comment(i + 1)) : [21, 22, 23, 24, 25].map(comment);
        return jsonResponse(items);
      },
    });
    const out = parse((await callTool(tools, 'github_get_issue', { issue_number: 9 })).text);
    assert.equal(out.comments_total, 25);
    assert.equal(out.comments.length, 20);
    assert.equal(out.comments[0].body, 'comment 6');
    assert.equal(out.comments[19].body, 'comment 25');
    assert.deepEqual(
      calls.filter((c) => c.path.endsWith('/comments')).map((c) => c.query.get('page')).sort(),
      ['1', '2'],
    );
  });

  test('github_get_issue skips comments when include_comments is false', async () => {
    const { tools, calls } = setup({
      'GET /repos/acme/app/issues/3': ok({ number: 3, title: 'T', state: 'open', comments: 4, user: { login: 'x' } }),
    });
    const out = parse((await callTool(tools, 'github_get_issue', { issue_number: 3, include_comments: false })).text);
    assert.deepEqual(out.comments, []);
    assert.equal(calls.length, 1);
  });

  test('github_list_prs prefixes same-repo head branches with the owner', async () => {
    const { tools, calls } = setup({
      'GET /repos/acme/app/pulls': ok([{ number: 4, title: 'Feat', state: 'open', draft: false, user: { login: 'a' }, head: { ref: 'feat' }, base: { ref: 'main' } }]),
    });
    const out = parse((await callTool(tools, 'github_list_prs', { head: 'feat' })).text);
    assert.equal(out.pull_requests[0].head, 'feat');
    assert.equal(calls[0].query.get('head'), 'acme:feat');
    assert.equal(calls[0].query.get('direction'), 'desc');
  });

  test('github_get_pr summarizes files and the latest review per reviewer', async () => {
    const { tools } = setup({
      'GET /repos/acme/app/pulls/5': ok({ number: 5, title: 'Fix', state: 'open', changed_files: 2, additions: 3, deletions: 1, user: { login: 'a' }, head: { ref: 'fix', sha: 'abc' }, base: { ref: 'main' }, body: 'desc' }),
      'GET /repos/acme/app/pulls/5/files': ok([
        { filename: 'a.js', status: 'modified', additions: 2, deletions: 1 },
        { filename: 'b.js', status: 'renamed', additions: 1, deletions: 0, previous_filename: 'old.js' },
      ]),
      'GET /repos/acme/app/pulls/5/reviews': ok([
        { user: { login: 'r1' }, state: 'CHANGES_REQUESTED', submitted_at: '1' },
        { user: { login: 'r1' }, state: 'APPROVED', submitted_at: '2' },
        { user: { login: 'r2' }, state: 'COMMENTED', submitted_at: '3' },
        { user: { login: 'r3' }, state: 'PENDING' },
      ]),
    });
    const out = parse((await callTool(tools, 'github_get_pr', { pull_number: 5 })).text);
    assert.equal(out.files.length, 2);
    assert.equal(out.files[1].previous_filename, 'old.js');
    assert.equal(out.files_truncated, false);
    assert.deepEqual(out.review_summary, { APPROVED: 1, COMMENTED: 1 });
    assert.equal(out.reviews.find((r) => r.reviewer === 'r1').state, 'APPROVED');
  });
});

describe('github_get_pr_diff', () => {
  const DIFF = [
    'diff --git a/src/a.js b/src/a.js',
    'index 1..2 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/docs/readme.md b/docs/readme.md',
    '--- a/docs/readme.md',
    '+++ b/docs/readme.md',
    '@@ -1 +1 @@',
    `+${'x'.repeat(3000)}`,
    '',
  ].join('\n');

  const diffRoute = {
    'GET /repos/acme/app/pulls/8': () => new Response(DIFF, { status: 200, headers: { 'content-type': 'text/plain' } }),
  };

  test('requests the diff media type and returns one file section', async () => {
    const { tools, calls } = setup(diffRoute);
    const { text } = await callTool(tools, 'github_get_pr_diff', { pull_number: 8, file_path: 'src/a.js' });
    assert.equal(calls[0].init.headers.Accept, 'application/vnd.github.v3.diff');
    assert.ok(text.startsWith('diff --git a/src/a.js b/src/a.js'));
    assert.ok(text.includes('+new'));
    assert.ok(!text.includes('docs/readme.md'));
  });

  test('truncates with a notice when over max_chars', async () => {
    const { tools } = setup(diffRoute);
    const { text } = await callTool(tools, 'github_get_pr_diff', { pull_number: 8, max_chars: 1000 });
    assert.match(text, /\[truncated: showing first 1000 of \d+ characters\]/);
  });

  test('lists changed files when the requested file is not in the diff', async () => {
    const { tools } = setup(diffRoute);
    const res = await callTool(tools, 'github_get_pr_diff', { pull_number: 8, file_path: 'missing.js' });
    assert.ok(res.isError);
    assert.match(res.text, /No diff found for "missing.js".*src\/a\.js, docs\/readme\.md/);
  });

  test('extractFileDiff matches renamed files by the new path', () => {
    const diff = 'diff --git a/old.js b/new.js\nsimilarity index 90%\n';
    assert.ok(extractFileDiff(diff, 'new.js'));
    assert.ok(extractFileDiff(diff, 'old.js'));
    assert.equal(extractFileDiff(diff, 'other.js'), null);
  });
});

describe('write tools', () => {
  test('github_create_issue posts the issue', async () => {
    const { tools, calls } = setup({
      'POST /repos/acme/app/issues': ok({ number: 12, state: 'open', html_url: 'u' }, 201),
    });
    const out = parse((await callTool(tools, 'github_create_issue', { title: 'Bug', labels: ['bug'] })).text);
    assert.equal(out.number, 12);
    assert.deepEqual(JSON.parse(calls[0].init.body), { title: 'Bug', labels: ['bug'] });
  });

  test('github_comment_issue posts the comment body', async () => {
    const { tools, calls } = setup({
      'POST /repos/acme/app/issues/3/comments': ok({ id: 99, html_url: 'u' }, 201),
    });
    const out = parse((await callTool(tools, 'github_comment_issue', { issue_number: 3, body: 'Thanks' })).text);
    assert.equal(out.id, 99);
    assert.deepEqual(JSON.parse(calls[0].init.body), { body: 'Thanks' });
  });

  test('github_create_pr defaults base to the repository default branch', async () => {
    const { tools, calls } = setup({
      'GET /repos/acme/app': ok({ default_branch: 'develop' }),
      'POST /repos/acme/app/pulls': ok({ number: 30, draft: true, head: { ref: 'feat' }, base: { ref: 'develop' }, html_url: 'u' }, 201),
    });
    const out = parse((await callTool(tools, 'github_create_pr', { title: 'Feat', head: 'feat', draft: true })).text);
    assert.equal(out.number, 30);
    const post = calls.find((c) => c.method === 'POST');
    assert.deepEqual(JSON.parse(post.init.body), { title: 'Feat', head: 'feat', base: 'develop', draft: true });
  });

  test('github_review_pr sends inline comments with RIGHT as default side', async () => {
    const { tools, calls } = setup({
      'POST /repos/acme/app/pulls/5/reviews': ok({ id: 1, state: 'CHANGES_REQUESTED', html_url: 'u' }),
    });
    await callTool(tools, 'github_review_pr', {
      pull_number: 5,
      event: 'REQUEST_CHANGES',
      body: 'Please fix',
      comments: [{ path: 'a.js', line: 3, body: 'Null check' }],
    });
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      event: 'REQUEST_CHANGES',
      body: 'Please fix',
      comments: [{ path: 'a.js', line: 3, side: 'RIGHT', body: 'Null check' }],
    });
  });

  test('github_review_pr rejects REQUEST_CHANGES without a body before calling GitHub', async () => {
    const { tools, calls } = setup();
    const res = await callTool(tools, 'github_review_pr', { pull_number: 5, event: 'REQUEST_CHANGES' });
    assert.ok(res.isError);
    assert.match(res.text, /body is required/);
    assert.equal(calls.length, 0);
  });

  test('github_create_release defaults to a draft', async () => {
    const { tools, calls } = setup({
      'POST /repos/acme/app/releases': ok({ id: 1, tag_name: 'v1.0.0', draft: true, prerelease: false, html_url: 'u' }, 201),
    });
    const out = parse((await callTool(tools, 'github_create_release', { tag_name: 'v1.0.0' })).text);
    assert.equal(out.draft, true);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.draft, true);
    assert.equal(body.prerelease, false);
    assert.equal(body.generate_release_notes, false);
  });

  test('github_rerun_workflow picks the endpoint from failed_only', async () => {
    const empty = () => new Response(null, { status: 201 });
    const { tools, calls } = setup({
      'POST /repos/acme/app/actions/runs/77/rerun-failed-jobs': empty,
      'POST /repos/acme/app/actions/runs/77/rerun': empty,
    });
    const first = parse((await callTool(tools, 'github_rerun_workflow', { run_id: 77 })).text);
    assert.equal(first.mode, 'failed_jobs');
    const second = parse((await callTool(tools, 'github_rerun_workflow', { run_id: 77, failed_only: false })).text);
    assert.equal(second.mode, 'all_jobs');
    assert.deepEqual(calls.map((c) => c.path), [
      '/repos/acme/app/actions/runs/77/rerun-failed-jobs',
      '/repos/acme/app/actions/runs/77/rerun',
    ]);
  });

  test('GitHub API errors become tool errors', async () => {
    const { tools } = setup({
      'POST /repos/acme/app/issues/404/comments': ok({ message: 'Not Found' }, 404),
    });
    const res = await callTool(tools, 'github_comment_issue', { issue_number: 404, body: 'x' });
    assert.ok(res.isError);
    assert.match(res.text, /Not found \(404\)/);
  });
});

describe('Actions tools', () => {
  test('github_list_workflow_runs maps runs and forwards filters', async () => {
    const { tools, calls } = setup({
      'GET /repos/acme/app/actions/runs': ok({
        total_count: 1,
        workflow_runs: [{ id: 1, name: 'CI', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'failure', head_sha: 'abc' }],
      }),
    });
    const out = parse((await callTool(tools, 'github_list_workflow_runs', { branch: 'main', status: 'failure' })).text);
    assert.equal(out.runs[0].workflow, 'CI');
    assert.equal(out.runs[0].conclusion, 'failure');
    assert.equal(calls[0].query.get('branch'), 'main');
    assert.equal(calls[0].query.get('per_page'), '15');
  });

  test('github_get_workflow_logs follows the 302 without Authorization and tails the log', async () => {
    const log = Array.from({ length: 200 }, (_, i) => `2026-11-25T10:00:00.1234567Z line ${i + 1}`).join('\n') + '\n';
    const { tools, calls } = setup({
      'GET /repos/acme/app/actions/runs/55/jobs': ok({
        jobs: [
          { id: 1, name: 'build', status: 'completed', conclusion: 'success', steps: [] },
          {
            id: 2,
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            steps: [
              { name: 'Checkout', conclusion: 'success' },
              { name: 'Run tests', conclusion: 'failure' },
            ],
          },
        ],
      }),
      'GET /repos/acme/app/actions/jobs/2/logs': () =>
        new Response(null, { status: 302, headers: { location: 'https://blob.storage.test/job-2.txt?sig=abc' } }),
      'GET /job-2.txt': () => new Response(log, { status: 200 }),
    });

    const { text } = await callTool(tools, 'github_get_workflow_logs', { run_id: 55, tail_lines: 10 });
    const summary = JSON.parse(text.slice(0, text.indexOf('\n\n---')));
    assert.equal(summary.failed_jobs, 1);
    assert.deepEqual(summary.jobs[1].failed_steps, ['Run tests']);
    assert.match(text, /--- test \(job 2, failure\): last 10 lines ---\nline 191\n/);
    assert.ok(text.trimEnd().endsWith('line 200'));
    assert.ok(!text.includes('2026-11-25T10:00:00'), 'timestamps should be stripped');

    const storageCall = calls.find((c) => c.host === 'blob.storage.test');
    assert.ok(storageCall, 'expected a request to the storage host');
    const headerNames = Object.keys(storageCall.init.headers).map((h) => h.toLowerCase());
    assert.ok(!headerNames.includes('authorization'), 'Authorization leaked to storage');
    assert.equal(calls.find((c) => c.path === '/repos/acme/app/actions/jobs/2/logs').init.redirect, 'manual');
  });

  test('github_get_workflow_logs reports unavailable logs without failing the tool', async () => {
    const { tools } = setup({
      'GET /repos/acme/app/actions/runs/56/jobs': ok({ jobs: [{ id: 3, name: 'lint', conclusion: 'failure', steps: [] }] }),
      'GET /repos/acme/app/actions/jobs/3/logs': ok({ message: 'Not Found' }, 404),
    });
    const res = await callTool(tools, 'github_get_workflow_logs', { run_id: 56 });
    assert.equal(res.isError, false);
    assert.match(res.text, /--- lint \(job 3\): logs unavailable: Not found \(404\)/);
  });

  test('github_get_workflow_logs says when nothing failed', async () => {
    const { tools } = setup({
      'GET /repos/acme/app/actions/runs/57/jobs': ok({ jobs: [{ id: 4, name: 'ok', conclusion: 'success', steps: [] }] }),
    });
    const { text } = await callTool(tools, 'github_get_workflow_logs', { run_id: 57 });
    assert.match(text, /No failed jobs in this run\./);
  });

  test('tailLines strips Actions timestamps and trailing blank lines', () => {
    const out = tailLines('2026-01-01T00:00:00Z a\r\n2026-01-01T00:00:01.5Z b\n\n', 5);
    assert.equal(out, 'a\nb');
  });
});

describe('github_search_code', () => {
  const searchRoute = {
    'GET /search/code': ok({
      total_count: 1,
      incomplete_results: false,
      items: [{ path: 'src/a.js', repository: { full_name: 'acme/app' }, html_url: 'u', text_matches: [{ fragment: 'parseConfig()' }] }],
    }),
  };

  test('scopes to explicit owner/repo and requests text matches', async () => {
    const { tools, calls } = setup(searchRoute);
    const out = parse((await callTool(tools, 'github_search_code', { query: 'parseConfig', owner: 'octo', repo: 'tools' })).text);
    assert.equal(calls[0].query.get('q'), 'parseConfig repo:octo/tools');
    assert.equal(calls[0].init.headers.Accept, 'application/vnd.github.text-match+json');
    assert.deepEqual(out.items[0].matches, ['parseConfig()']);
  });

  test('scopes to the current repo only when asked', async () => {
    const { tools, calls } = setup(searchRoute);
    await callTool(tools, 'github_search_code', { query: 'parseConfig', scope_current_repo: true });
    await callTool(tools, 'github_search_code', { query: 'parseConfig' });
    await callTool(tools, 'github_search_code', { query: 'x repo:other/one', scope_current_repo: true });
    assert.deepEqual(calls.map((c) => c.query.get('q')), [
      'parseConfig repo:acme/app',
      'parseConfig',
      'x repo:other/one',
    ]);
  });
});

describe('stdio server', () => {
  test('answers initialize, tools/list, tool errors, and parse errors over stdio', { timeout: 15000 }, async () => {
    const child = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const responses = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout; stdout=${stdout} stderr=${stderr}`)), 10000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        const lines = stdout.split('\n').filter(Boolean);
        if (lines.length >= 4) {
          clearTimeout(timer);
          resolve(lines.map((line) => JSON.parse(line)));
        }
      });
      child.on('error', reject);

      const send = (msg) => child.stdin.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\r\n`);
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'github_get_issue', arguments: {} } });
      send('{not json');
    });

    const exitCode = await new Promise((resolve) => {
      child.on('close', resolve);
      child.stdin.end();
    });

    const byId = new Map(responses.map((r) => [r.id, r]));
    assert.equal(byId.get(1).result.protocolVersion, '2025-03-26');
    assert.equal(byId.get(1).result.serverInfo.name, 'github-kit');
    assert.equal(byId.get(2).result.tools.length, 16);
    assert.equal(byId.get(3).result.isError, true);
    assert.match(byId.get(3).result.content[0].text, /Missing required argument: issue_number/);
    assert.equal(byId.get(null).error.code, -32700);
    assert.equal(exitCode, 0);
    assert.equal(stderr, '');
  });
});
