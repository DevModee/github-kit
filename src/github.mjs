// GitHub REST client, token resolution, and repository detection for github-kit.
// Zero runtime dependencies: uses the global fetch and node:child_process.

import { execFile } from 'node:child_process';

export const DEFAULT_API_URL = 'https://api.github.com';
export const API_VERSION = '2022-11-28';
export const USER_AGENT = 'github-kit-antigravity/1.0.0';
export const DEFAULT_MAX_TEXT_CHARS = 60000;

const COMMAND_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 30000;
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const NO_TOKEN_MESSAGE =
  'No GitHub token found. Set GITHUB_TOKEN (or GH_TOKEN) in the environment, ' +
  'or install the GitHub CLI and run `gh auth login`.';

export class GitHubError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

function runCommand(file, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd, timeout: COMMAND_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())),
    );
  });
}

// ---------------------------------------------------------------------------
// Token resolution: GITHUB_TOKEN -> GH_TOKEN -> `gh auth token` (cached).
// ---------------------------------------------------------------------------

export function createTokenResolver({
  env = process.env,
  runGh = () => runCommand('gh', ['auth', 'token']),
} = {}) {
  let cached = null;

  return {
    async get() {
      const fromEnv = String(env.GITHUB_TOKEN || '').trim() || String(env.GH_TOKEN || '').trim();
      if (fromEnv) return fromEnv;

      if (!cached) {
        cached = Promise.resolve()
          .then(runGh)
          .then((out) => {
            const token = String(out || '').trim();
            if (!token) throw new Error('empty token');
            return token;
          })
          .catch(() => {
            cached = null;
            throw new GitHubError(NO_TOKEN_MESSAGE);
          });
      }
      return cached;
    },
    invalidate() {
      cached = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Repository detection from `git remote get-url origin`.
// ---------------------------------------------------------------------------

export function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && name !== '.' && name !== '..';
}

// Hosts accepted as GitHub remotes: github.com plus the host behind a custom
// GITHUB_API_URL (GitHub Enterprise Server or ghe.com, minus a leading "api.").
export function remoteHostsFor(apiUrl = DEFAULT_API_URL) {
  const hosts = ['github.com'];
  try {
    const host = new URL(apiUrl).hostname.toLowerCase().replace(/^api\./, '');
    if (host && !hosts.includes(host)) hosts.push(host);
  } catch {
    // Invalid apiUrl: keep the github.com default.
  }
  return hosts;
}

export function parseRemoteUrl(remoteUrl, hosts = ['github.com']) {
  const text = String(remoteUrl || '').trim();
  const allowed = new Set(hosts.map((h) => h.toLowerCase()));
  let host;
  let path;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    host = url.hostname;
    path = url.pathname;
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text);
    if (!scp) return null;
    host = scp[1];
    path = scp[2];
  }

  if (!allowed.has(host.toLowerCase())) return null;

  const parts = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
  if (parts.length !== 2) return null;

  const [owner, repo] = parts;
  if (!isValidName(owner) || !isValidName(repo)) return null;
  return { owner, repo };
}

export async function resolveRepo(
  { owner, repo, cwd } = {},
  {
    runGit = (dir) => runCommand('git', ['remote', 'get-url', 'origin'], { cwd: dir }),
    hosts = ['github.com'],
  } = {},
) {
  if (owner || repo) {
    if (!owner || !repo) {
      throw new GitHubError(
        'Provide both owner and repo, or omit both to detect them from the git remote "origin".',
      );
    }
    if (!isValidName(owner) || !isValidName(repo)) {
      throw new GitHubError(
        'Invalid owner or repo name. Allowed characters are letters, digits, "-", "_", and ".".',
      );
    }
    return { owner, repo };
  }

  const dir = cwd || process.cwd();
  let remote;
  try {
    remote = await runGit(dir);
  } catch {
    throw new GitHubError(
      `Could not read the git remote "origin" in ${dir}. ` +
        'Pass owner and repo explicitly, or run from a GitHub repository checkout.',
    );
  }

  // The raw remote URL is never echoed back: it can embed credentials.
  const parsed = parseRemoteUrl(remote, hosts);
  if (!parsed) {
    throw new GitHubError(
      `The git remote "origin" in ${dir} is not a GitHub repository URL. Pass owner and repo explicitly.`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Text helpers.
// ---------------------------------------------------------------------------

export function truncateText(text, maxChars = DEFAULT_MAX_TEXT_CHARS, { keep = 'head' } = {}) {
  const value = String(text ?? '');
  if (!(maxChars > 0) || value.length <= maxChars) return value;
  if (keep === 'tail') {
    return `[truncated: showing last ${maxChars} of ${value.length} characters]\n\n${value.slice(-maxChars)}`;
  }
  return `${value.slice(0, maxChars)}\n\n[truncated: showing first ${maxChars} of ${value.length} characters]`;
}

function describeNetworkError(err, timeoutMs) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `timed out after ${timeoutMs} ms`;
  return err?.cause?.code || err?.message || 'unknown error';
}

async function toGitHubError(res, method, path) {
  const text = await res.text().catch(() => '');
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Non-JSON error body.
  }
  const apiMessage = data && data.message ? String(data.message) : '';
  const where = `${method} ${path}`;

  if (res.status === 401) {
    return new GitHubError(
      'GitHub rejected the token (401 Bad credentials). Set a valid GITHUB_TOKEN or GH_TOKEN, or run `gh auth login` again.',
      401,
    );
  }

  if (res.status === 403 || res.status === 429) {
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const when = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : 'an unknown time';
      return new GitHubError(`GitHub API rate limit exceeded. It resets at ${when}.`, res.status);
    }
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) {
      return new GitHubError(
        `GitHub secondary rate limit hit on ${where}. Retry after ${retryAfter} seconds.`,
        res.status,
      );
    }
    return new GitHubError(
      `Forbidden (${res.status}) on ${where}: ${apiMessage || 'the token lacks permission for this resource'}`,
      res.status,
    );
  }

  if (res.status === 404) {
    return new GitHubError(
      `Not found (404) on ${where}. Check the owner, repo, and number, and that the token can access this repository.`,
      404,
    );
  }

  if (res.status === 422) {
    const details = Array.isArray(data?.errors)
      ? data.errors
          .map((e) => (typeof e === 'string' ? e : e.message || [e.resource, e.field, e.code].filter(Boolean).join(' ')))
          .filter(Boolean)
          .join('; ')
      : '';
    return new GitHubError(
      `Validation failed (422) on ${where}: ${apiMessage || 'invalid request'}${details ? ` (${details})` : ''}`,
      422,
    );
  }

  return new GitHubError(
    `GitHub API error ${res.status} on ${where}${apiMessage ? `: ${apiMessage}` : ''}`,
    res.status,
  );
}

// ---------------------------------------------------------------------------
// Client factory.
// ---------------------------------------------------------------------------

export function createGitHubClient({
  fetchImpl = globalThis.fetch,
  tokenResolver = createTokenResolver(),
  repoResolver,
  apiUrl = process.env.GITHUB_API_URL || DEFAULT_API_URL,
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const tokens =
    typeof tokenResolver === 'function' ? { get: tokenResolver, invalidate() {} } : tokenResolver;
  const baseUrl = String(apiUrl).replace(/\/+$/, '');
  const hosts = remoteHostsFor(baseUrl);
  const resolveRepoFn = repoResolver || ((args) => resolveRepo(args, { hosts }));

  function buildUrl(path, query) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new GitHubError('API path must start with "/".');
    }
    const url = new URL(baseUrl + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    return url.toString();
  }

  async function send(path, { method, query, body, accept, redirect = 'follow' }) {
    const token = await tokens.get();
    const headers = {
      Accept: accept || 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
    };
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const url = buildUrl(path, query);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: payload,
        redirect,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new GitHubError(
        `Network error calling GitHub (${method} ${path}): ${describeNetworkError(err, timeoutMs)}`,
      );
    }
    if (res.status === 401) tokens.invalidate();
    return { res, url };
  }

  // JSON by default. Returns text (truncated) when `raw` is set or the response is not JSON.
  async function request(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const { res } = await send(path, { ...options, method });
    if (!res.ok) throw await toGitHubError(res, method, path);
    if (res.status === 204) return null;

    const type = res.headers.get('content-type') || '';
    const text = await res.text();
    if (options.raw || !type.includes('json')) {
      return truncateText(text, options.maxChars ?? maxTextChars, { keep: options.keep });
    }
    return text ? JSON.parse(text) : null;
  }

  // For endpoints that answer with a redirect to signed storage (Actions logs).
  // The redirect is followed manually and the second request never carries the
  // GitHub Authorization header.
  async function downloadText(path, { maxChars = maxTextChars, keep = 'head', accept } = {}) {
    const method = 'GET';
    const { res, url } = await send(path, { method, accept, redirect: 'manual' });

    let finalRes = res;
    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location');
      if (!location) {
        throw new GitHubError(`GitHub returned a redirect without a location on ${method} ${path}.`, res.status);
      }
      try {
        finalRes = await fetchImpl(new URL(location, url).toString(), {
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT },
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new GitHubError(
          `Network error downloading content for ${method} ${path}: ${describeNetworkError(err, timeoutMs)}`,
        );
      }
      if (!finalRes.ok) {
        throw new GitHubError(
          `Download failed (${finalRes.status}) for ${method} ${path}. The signed URL may have expired; try again.`,
          finalRes.status,
        );
      }
    } else if (!res.ok) {
      throw await toGitHubError(res, method, path);
    }

    return truncateText(await finalRes.text(), maxChars, { keep });
  }

  async function repoContext(args = {}) {
    const { owner, repo } = await resolveRepoFn(args);
    return {
      owner,
      repo,
      repoPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    };
  }

  return {
    apiUrl: baseUrl,
    request,
    downloadText,
    resolveRepo: resolveRepoFn,
    repoContext,
    invalidateToken: () => tokens.invalidate(),
  };
}

let defaultClient = null;

export function getDefaultClient() {
  if (!defaultClient) defaultClient = createGitHubClient();
  return defaultClient;
}

export function githubRequest(path, options) {
  return getDefaultClient().request(path, options);
}
