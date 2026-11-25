import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_VERSION,
  USER_AGENT,
  GitHubError,
  createGitHubClient,
  createTokenResolver,
  parseRemoteUrl,
  remoteHostsFor,
  resolveRepo,
  truncateText,
} from '../src/github.mjs';

const TOKEN = 'ghp_unitTestToken0123456789';
const API = 'https://api.test.local';

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

// Queue-based fetch mock: each call consumes the next response (or handler).
function mockFetch(...responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    return typeof next === 'function' ? next(String(url), init) : next;
  };
  fn.calls = calls;
  return fn;
}

function makeClient(fetchImpl, extra = {}) {
  return createGitHubClient({ fetchImpl, tokenResolver: async () => TOKEN, apiUrl: API, ...extra });
}

async function rejectsWithoutToken(promise, pattern) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof GitHubError, `expected GitHubError, got ${err}`);
    assert.match(err.message, pattern);
    assert.ok(!err.message.includes(TOKEN), 'error message leaked the token');
    return true;
  });
}

describe('parseRemoteUrl', () => {
  const cases = [
    ['https://github.com/DevModee/github-kit', 'HTTPS without suffix'],
    ['https://github.com/DevModee/github-kit.git', 'HTTPS with .git'],
    ['https://github.com/DevModee/github-kit/', 'HTTPS with trailing slash'],
    ['https://user:secret@github.com/DevModee/github-kit.git', 'HTTPS with credentials'],
    ['git@github.com:DevModee/github-kit.git', 'SCP-style SSH'],
    ['git@github.com:DevModee/github-kit', 'SCP-style SSH without .git'],
    ['ssh://git@github.com/DevModee/github-kit.git', 'ssh:// URL'],
    ['ssh://git@github.com:22/DevModee/github-kit', 'ssh:// URL with port'],
  ];
  for (const [url, label] of cases) {
    test(label, () => {
      assert.deepEqual(parseRemoteUrl(url), { owner: 'DevModee', repo: 'github-kit' });
    });
  }

  test('keeps dots in repo names', () => {
    assert.deepEqual(parseRemoteUrl('git@github.com:acme/.github.git'), { owner: 'acme', repo: '.github' });
  });

  test('rejects non-GitHub hosts and malformed paths', () => {
    assert.equal(parseRemoteUrl('https://gitlab.com/acme/app.git'), null);
    assert.equal(parseRemoteUrl('git@bitbucket.org:acme/app.git'), null);
    assert.equal(parseRemoteUrl('https://github.com/acme'), null);
    assert.equal(parseRemoteUrl('https://github.com/acme/app/tree/main'), null);
    assert.equal(parseRemoteUrl('https://github.com/../app'), null);
    assert.equal(parseRemoteUrl('C:\\repos\\app'), null);
    assert.equal(parseRemoteUrl(''), null);
  });

  test('accepts an enterprise host derived from the API URL', () => {
    const hosts = remoteHostsFor('https://api.acme.ghe.com');
    assert.deepEqual(hosts, ['github.com', 'acme.ghe.com']);
    assert.deepEqual(parseRemoteUrl('git@acme.ghe.com:team/app.git', hosts), { owner: 'team', repo: 'app' });
    assert.deepEqual(remoteHostsFor('https://ghe.example.com/api/v3'), ['github.com', 'ghe.example.com']);
  });
});

describe('resolveRepo', () => {
  test('returns explicit owner and repo without calling git', async () => {
    const runGit = () => assert.fail('git should not run');
    assert.deepEqual(await resolveRepo({ owner: 'acme', repo: 'app' }, { runGit }), { owner: 'acme', repo: 'app' });
  });

  test('rejects partial or invalid overrides', async () => {
    await assert.rejects(resolveRepo({ owner: 'acme' }), /both owner and repo/);
    await assert.rejects(resolveRepo({ owner: 'acme', repo: '..' }), /Invalid owner or repo/);
    await assert.rejects(resolveRepo({ owner: 'acme', repo: 'a/b' }), /Invalid owner or repo/);
  });

  test('detects owner and repo from git remote origin in the given cwd', async () => {
    let seenCwd;
    const runGit = async (dir) => {
      seenCwd = dir;
      return 'git@github.com:DevModee/github-kit.git';
    };
    const result = await resolveRepo({ cwd: '/work/project' }, { runGit });
    assert.deepEqual(result, { owner: 'DevModee', repo: 'github-kit' });
    assert.equal(seenCwd, '/work/project');
  });

  test('explains how to recover when git fails', async () => {
    const runGit = async () => {
      throw new Error('fatal: not a git repository');
    };
    await assert.rejects(resolveRepo({ cwd: '/tmp/x' }, { runGit }), /Could not read the git remote "origin".*owner and repo/);
  });

  test('does not echo a non-GitHub remote that may contain credentials', async () => {
    const runGit = async () => 'https://user:s3cr3t@gitlab.com/acme/app.git';
    await assert.rejects(resolveRepo({}, { runGit }), (err) => {
      assert.match(err.message, /not a GitHub repository URL/);
      assert.ok(!err.message.includes('s3cr3t'));
      return true;
    });
  });
});

describe('createTokenResolver', () => {
  test('prefers GITHUB_TOKEN over GH_TOKEN and never calls gh', async () => {
    const runGh = () => assert.fail('gh should not run');
    const resolver = createTokenResolver({ env: { GITHUB_TOKEN: ' a ', GH_TOKEN: 'b' }, runGh });
    assert.equal(await resolver.get(), 'a');
    const fallback = createTokenResolver({ env: { GH_TOKEN: 'b' }, runGh });
    assert.equal(await fallback.get(), 'b');
  });

  test('falls back to gh auth token, caches it, and refreshes after invalidate', async () => {
    let calls = 0;
    const runGh = async () => {
      calls += 1;
      return `gho_token${calls}\n`;
    };
    const resolver = createTokenResolver({ env: {}, runGh });
    assert.equal(await resolver.get(), 'gho_token1');
    assert.equal(await resolver.get(), 'gho_token1');
    assert.equal(calls, 1);
    resolver.invalidate();
    assert.equal(await resolver.get(), 'gho_token2');
    assert.equal(calls, 2);
  });

  test('throws an actionable error when no token is available', async () => {
    const runGh = async () => {
      throw new Error('gh: command not found');
    };
    const resolver = createTokenResolver({ env: {}, runGh });
    await assert.rejects(resolver.get(), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.match(err.message, /GITHUB_TOKEN/);
      assert.match(err.message, /gh auth login/);
      return true;
    });
  });

  test('treats empty gh output as missing token', async () => {
    const resolver = createTokenResolver({ env: {}, runGh: async () => '   ' });
    await assert.rejects(resolver.get(), /No GitHub token found/);
  });
});

describe('truncateText', () => {
  test('returns short text unchanged', () => {
    assert.equal(truncateText('abc', 10), 'abc');
  });

  test('keeps the head with a notice by default', () => {
    const out = truncateText('abcdefghij', 4);
    assert.ok(out.startsWith('abcd\n'));
    assert.match(out, /\[truncated: showing first 4 of 10 characters\]/);
  });

  test('keeps the tail when requested', () => {
    const out = truncateText('abcdefghij', 3, { keep: 'tail' });
    assert.ok(out.endsWith('\nhij'));
    assert.match(out, /\[truncated: showing last 3 of 10 characters\]/);
  });
});

describe('createGitHubClient.request', () => {
  test('sends GitHub headers, query params, and parses JSON', async () => {
    const fetchImpl = mockFetch(jsonResponse([{ number: 1 }]));
    const client = makeClient(fetchImpl);
    const data = await client.request('/repos/acme/app/issues', {
      query: { state: 'open', labels: ['bug', 'ui'], assignee: undefined, per_page: 10 },
    });

    assert.deepEqual(data, [{ number: 1 }]);
    const { url, init } = fetchImpl.calls[0];
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, `${API}/repos/acme/app/issues`);
    assert.equal(parsed.searchParams.get('state'), 'open');
    assert.equal(parsed.searchParams.get('labels'), 'bug,ui');
    assert.equal(parsed.searchParams.get('per_page'), '10');
    assert.equal(parsed.searchParams.has('assignee'), false);
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers.Accept, 'application/vnd.github+json');
    assert.equal(init.headers['X-GitHub-Api-Version'], API_VERSION);
    assert.equal(init.headers['User-Agent'], USER_AGENT);
    assert.equal(init.body, undefined);
  });

  test('keeps an API base path such as /api/v3', async () => {
    const fetchImpl = mockFetch(jsonResponse({ login: 'me' }));
    const client = makeClient(fetchImpl, { apiUrl: 'https://ghe.example.com/api/v3/' });
    await client.request('/user');
    assert.equal(fetchImpl.calls[0].url, 'https://ghe.example.com/api/v3/user');
  });

  test('serializes JSON bodies for write requests', async () => {
    const fetchImpl = mockFetch(jsonResponse({ number: 7 }, 201));
    const client = makeClient(fetchImpl);
    await client.request('/repos/acme/app/issues', { method: 'post', body: { title: 'Bug' } });
    const { init } = fetchImpl.calls[0];
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { title: 'Bug' });
  });

  test('returns null for 204 responses', async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 204 }));
    const client = makeClient(fetchImpl);
    assert.equal(await client.request('/x', { method: 'POST' }), null);
  });

  test('returns truncated raw text with a custom Accept header', async () => {
    const diff = 'diff --git a/x b/x\n' + 'x'.repeat(200);
    const fetchImpl = mockFetch(new Response(diff, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const client = makeClient(fetchImpl);
    const out = await client.request('/repos/acme/app/pulls/1', {
      accept: 'application/vnd.github.v3.diff',
      raw: true,
      maxChars: 50,
    });
    assert.equal(fetchImpl.calls[0].init.headers.Accept, 'application/vnd.github.v3.diff');
    assert.ok(out.startsWith('diff --git'));
    assert.match(out, /\[truncated: showing first 50 of \d+ characters\]/);
  });

  test('rejects paths that do not start with a slash', async () => {
    const client = makeClient(mockFetch());
    await assert.rejects(client.request('user'), /must start with/);
  });
});

describe('createGitHubClient error handling', () => {
  test('401 invalidates the cached token and never leaks it', async () => {
    let invalidated = 0;
    const tokenResolver = { get: async () => TOKEN, invalidate: () => { invalidated += 1; } };
    const fetchImpl = mockFetch(jsonResponse({ message: 'Bad credentials' }, 401));
    const client = createGitHubClient({ fetchImpl, tokenResolver, apiUrl: API });
    await rejectsWithoutToken(client.request('/user'), /401 Bad credentials.*gh auth login/);
    assert.equal(invalidated, 1);
  });

  test('403 with exhausted rate limit reports the reset time', async () => {
    const reset = 1893456000; // 2030-01-01T00:00:00Z
    const fetchImpl = mockFetch(
      jsonResponse({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(reset),
      }),
    );
    await rejectsWithoutToken(makeClient(fetchImpl).request('/user'), /rate limit exceeded.*2030-01-01T00:00:00\.000Z/);
  });

  test('403 secondary rate limit reports retry-after', async () => {
    const fetchImpl = mockFetch(jsonResponse({ message: 'secondary' }, 403, { 'retry-after': '60' }));
    await rejectsWithoutToken(makeClient(fetchImpl).request('/search/code'), /secondary rate limit.*60 seconds/);
  });

  test('403 without rate limit headers reports the API message', async () => {
    const fetchImpl = mockFetch(jsonResponse({ message: 'Resource not accessible by integration' }, 403));
    await rejectsWithoutToken(makeClient(fetchImpl).request('/repos/a/b'), /Forbidden \(403\).*Resource not accessible/);
  });

  test('404 explains what to check', async () => {
    const fetchImpl = mockFetch(jsonResponse({ message: 'Not Found' }, 404));
    await rejectsWithoutToken(makeClient(fetchImpl).request('/repos/a/b/pulls/9'), /Not found \(404\) on GET \/repos\/a\/b\/pulls\/9/);
  });

  test('422 includes validation details', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(
        { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }, { message: 'No commits between main and feat' }] },
        422,
      ),
    );
    await rejectsWithoutToken(
      makeClient(fetchImpl).request('/repos/a/b/pulls', { method: 'POST', body: {} }),
      /Validation failed \(422\).*PullRequest head invalid; No commits between main and feat/,
    );
  });

  test('other statuses include status and API message', async () => {
    const fetchImpl = mockFetch(new Response('upstream down', { status: 502 }));
    await rejectsWithoutToken(makeClient(fetchImpl).request('/user'), /GitHub API error 502 on GET \/user/);
  });

  test('network failures are wrapped without leaking the token', async () => {
    const fetchImpl = mockFetch(() => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    });
    await rejectsWithoutToken(makeClient(fetchImpl).request('/user'), /Network error calling GitHub \(GET \/user\): ENOTFOUND/);
  });
});

describe('createGitHubClient.downloadText', () => {
  test('follows a 302 manually without sending Authorization to storage', async () => {
    const signed = 'https://blob.storage.test/logs/123?sig=abc';
    const fetchImpl = mockFetch(
      new Response(null, { status: 302, headers: { location: signed } }),
      new Response('line1\nline2\nERROR boom\n', { status: 200 }),
    );
    const client = makeClient(fetchImpl);
    const text = await client.downloadText('/repos/acme/app/actions/jobs/1/logs');

    assert.equal(text, 'line1\nline2\nERROR boom\n');
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(fetchImpl.calls[0].init.redirect, 'manual');
    assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(fetchImpl.calls[1].url, signed);
    const secondHeaders = Object.keys(fetchImpl.calls[1].init.headers).map((h) => h.toLowerCase());
    assert.ok(!secondHeaders.includes('authorization'), 'Authorization leaked to redirect target');
    assert.ok(!JSON.stringify(fetchImpl.calls[1].init).includes(TOKEN));
  });

  test('returns the body directly when there is no redirect, keeping the tail', async () => {
    const fetchImpl = mockFetch(new Response('0123456789', { status: 200 }));
    const out = await makeClient(fetchImpl).downloadText('/logs', { maxChars: 4, keep: 'tail' });
    assert.ok(out.endsWith('6789'));
    assert.match(out, /showing last 4 of 10/);
  });

  test('reports an expired signed URL without echoing it', async () => {
    const signed = 'https://blob.storage.test/logs/1?sig=secretsig';
    const fetchImpl = mockFetch(
      new Response(null, { status: 302, headers: { location: signed } }),
      new Response('AuthenticationFailed', { status: 403 }),
    );
    await assert.rejects(makeClient(fetchImpl).downloadText('/logs'), (err) => {
      assert.match(err.message, /Download failed \(403\)/);
      assert.ok(!err.message.includes('secretsig'));
      return true;
    });
  });

  test('maps API errors before the redirect', async () => {
    const fetchImpl = mockFetch(jsonResponse({ message: 'Not Found' }, 404));
    await rejectsWithoutToken(makeClient(fetchImpl).downloadText('/repos/a/b/actions/jobs/9/logs'), /Not found \(404\)/);
  });
});

describe('createGitHubClient.repoContext', () => {
  test('uses the injected repo resolver and builds the repo path', async () => {
    const client = makeClient(mockFetch(), {
      repoResolver: async ({ cwd }) => {
        assert.equal(cwd, '/work');
        return { owner: 'acme', repo: 'app' };
      },
    });
    assert.deepEqual(await client.repoContext({ cwd: '/work' }), {
      owner: 'acme',
      repo: 'app',
      repoPath: '/repos/acme/app',
    });
  });
});
