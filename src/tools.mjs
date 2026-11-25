// MCP tool definitions and handlers for github-kit.
// Each tool is { name, description, inputSchema, handler(args) -> string }.

import { relative, isAbsolute } from 'node:path';
import { GitHubError, truncateText } from './github.mjs';

const BODY_MAX_CHARS = 20000;
const COMMENT_MAX_CHARS = 4000;
const RECENT_COMMENTS = 20;
const MAX_PR_FILES = 100;
const MAX_LOG_JOBS = 5;
const LOG_MAX_CHARS = 20000;
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out']);
const LOG_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /;

// ---------------------------------------------------------------------------
// Argument normalization and validation (subset of JSON Schema used below).
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalize(schema, value) {
  if (value === undefined || value === null) {
    return schema.default !== undefined ? structuredClone(schema.default) : undefined;
  }
  if (schema.type === 'integer' && typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number(value);
  }
  if (schema.type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  if (schema.type === 'array' && typeof value === 'string' && schema.items?.type === 'string') {
    return value.split(',').map((v) => v.trim()).filter(Boolean);
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    return value.map((item) => normalize(schema.items, item));
  }
  if (schema.type === 'object' && schema.properties && isPlainObject(value)) {
    const out = { ...value };
    for (const [key, sub] of Object.entries(schema.properties)) {
      const next = normalize(sub, value[key]);
      if (next === undefined) delete out[key];
      else out[key] = next;
    }
    return out;
  }
  return value;
}

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => isPlainObject(v),
};

function validate(schema, value, path) {
  const check = TYPE_CHECKS[schema.type];
  if (check && !check(value)) return `${path} must be of type ${schema.type}`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(', ')}`;
  if (schema.type === 'string' && schema.minLength && value.trim().length < schema.minLength) {
    return `${path} must not be empty`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be >= ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be <= ${schema.maximum}`;
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i += 1) {
      const err = validate(schema.items, value[i], `${path}[${i}]`);
      if (err) return err;
    }
  }
  if (isPlainObject(value) && schema.properties) {
    const prefix = path === 'arguments' ? '' : `${path}.`;
    for (const key of schema.required || []) {
      if (value[key] === undefined || value[key] === null) return `Missing required argument: ${prefix}${key}`;
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (value[key] === undefined) continue;
      const err = validate(sub, value[key], `${prefix}${key}`);
      if (err) return err;
    }
  }
  return null;
}

export function prepareArgs(schema, args) {
  const value = normalize(schema, args ?? {});
  const error = validate(schema, value, 'arguments');
  return { args: value, error };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const json = (value) => JSON.stringify(value, null, 2);
const login = (user) => (user ? user.login : null);
const clip = (text, max) => (text ? truncateText(text, max) : '');
const isoFromEpoch = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);

function rateInfo(resource) {
  if (!resource) return null;
  return { limit: resource.limit, remaining: resource.remaining, reset: isoFromEpoch(resource.reset) };
}

export function extractFileDiff(diff, filePath) {
  const sections = String(diff).split(/^(?=diff --git )/m);
  return (
    sections.find((section) => {
      const header = section.split('\n', 1)[0];
      return header.startsWith(`diff --git a/${filePath} `) || header.endsWith(` b/${filePath}`);
    }) || null
  );
}

function diffFilePaths(diff) {
  const paths = [];
  for (const match of String(diff).matchAll(/^diff --git a\/.* b\/(.*)$/gm)) paths.push(match[1]);
  return paths;
}

export function tailLines(text, count) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.replace(LOG_TIMESTAMP_RE, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-count).join('\n');
}

function defaultCwdFromProcess() {
  const cwd = process.cwd();
  const root = process.env.PLUGIN_ROOT;
  if (root) {
    const rel = relative(root, cwd);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return null;
  }
  return cwd;
}

// ---------------------------------------------------------------------------
// Schemas.
// ---------------------------------------------------------------------------

const REPO_PROPS = {
  owner: { type: 'string', description: 'Repository owner. Omit with repo to detect from the git remote "origin" of cwd.' },
  repo: { type: 'string', description: 'Repository name. Omit with owner to detect from the git remote "origin" of cwd.' },
  cwd: { type: 'string', description: 'Absolute path of the local workspace, used to detect owner/repo.' },
};

const perPage = (def) => ({
  type: 'integer',
  minimum: 1,
  maximum: 50,
  default: def,
  description: `Number of results (1-50, default ${def}).`,
});

const positiveInt = (description) => ({ type: 'integer', minimum: 1, description });

function schema(properties, required = []) {
  return { type: 'object', properties, required };
}

// ---------------------------------------------------------------------------
// Tools.
// ---------------------------------------------------------------------------

export function createTools(client, { defaultCwd = defaultCwdFromProcess } = {}) {
  async function repoCtx(args) {
    const { owner, repo } = args;
    let { cwd } = args;
    if (!owner && !repo && !cwd) {
      cwd = defaultCwd();
      if (!cwd) {
        throw new GitHubError(
          'Could not detect the repository because the server is running inside the plugin directory. ' +
            'Pass cwd (the workspace path) or owner and repo.',
        );
      }
    }
    return client.repoContext({ owner, repo, cwd });
  }

  const tools = [
    {
      name: 'github_whoami',
      description: 'Show the authenticated GitHub user and the remaining core and search API rate limits.',
      inputSchema: schema({}),
      async handler() {
        const [user, limits] = await Promise.all([client.request('/user'), client.request('/rate_limit')]);
        return json({
          login: user.login,
          name: user.name,
          plan: user.plan ? user.plan.name : null,
          html_url: user.html_url,
          rate_limit: {
            core: rateInfo(limits.resources?.core),
            search: rateInfo(limits.resources?.search),
          },
        });
      },
    },

    {
      name: 'github_get_repo',
      description: 'Get repository metadata: default branch, description, visibility, stars, forks, open issues, topics.',
      inputSchema: schema({ ...REPO_PROPS }),
      async handler(args) {
        const { repoPath } = await repoCtx(args);
        const r = await client.request(repoPath);
        return json({
          full_name: r.full_name,
          description: r.description,
          visibility: r.visibility,
          default_branch: r.default_branch,
          stars: r.stargazers_count,
          forks: r.forks_count,
          open_issues: r.open_issues_count,
          topics: r.topics || [],
          archived: r.archived,
          pushed_at: r.pushed_at,
          html_url: r.html_url,
        });
      },
    },

    {
      name: 'github_list_issues',
      description: 'List repository issues (pull requests are excluded) filtered by state, labels, and assignee.',
      inputSchema: schema({
        ...REPO_PROPS,
        state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open', description: 'Issue state.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Only issues that have all these labels.' },
        assignee: { type: 'string', description: 'Login of the assignee, "none", or "*".' },
        per_page: perPage(30),
      }),
      async handler(args) {
        const { repoPath } = await repoCtx(args);
        const items = await client.request(`${repoPath}/issues`, {
          query: { state: args.state, labels: args.labels, assignee: args.assignee, per_page: args.per_page },
        });
        const issues = items
          .filter((item) => !item.pull_request)
          .map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            author: login(i.user),
            labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
            assignees: (i.assignees || []).map(login),
            comments: i.comments,
            created_at: i.created_at,
            updated_at: i.updated_at,
            html_url: i.html_url,
          }));
        return json({ count: issues.length, issues });
      },
    },

    {
      name: 'github_get_issue',
      description: 'Get an issue (or pull request conversation) with its body, labels, and the most recent comments.',
      inputSchema: schema(
        {
          ...REPO_PROPS,
          issue_number: positiveInt('Issue or pull request number.'),
          include_comments: { type: 'boolean', default: true, description: 'Include the most recent comments.' },
        },
        ['issue_number'],
      ),
      async handler(args) {
        const { repoPath } = await repoCtx(args);
        const base = `${repoPath}/issues/${args.issue_number}`;
        const issue = await client.request(base);

        let comments = [];
        if (args.include_comments && issue.comments > 0) {
          const lastPage = Math.ceil(issue.comments / RECENT_COMMENTS);
          const pages = lastPage > 1 ? [lastPage - 1, lastPage] : [lastPage];
          const results = await Promise.all(
            pages.map((page) => client.request(`${base}/comments`, { query: { per_page: RECENT_COMMENTS, page } })),
          );
          comments = results.flat().slice(-RECENT_COMMENTS).map((c) => ({
            author: login(c.user),
            created_at: c.created_at,
            body: clip(c.body, COMMENT_MAX_CHARS),
            html_url: c.html_url,
          }));
        }

        return json({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          state_reason: issue.state_reason ?? null,
          is_pull_request: Boolean(issue.pull_request),
          author: login(issue.user),
          labels: (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
          assignees: (issue.assignees || []).map(login),
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          html_url: issue.html_url,
          body: clip(issue.body, BODY_MAX_CHARS),
          comments_total: issue.comments,
          comments,
        });
      },
    },

    {
      name: 'github_create_issue',
      description: 'Create a new issue. State-changing: confirm with the user first.',
      inputSchema: schema(
        {
          ...REPO_PROPS,
          title: { type: 'string', minLength: 1, description: 'Issue title.' },
          body: { type: 'string', description: 'Issue body in Markdown.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply.' },
          assignees: { type: 'array', items: { type: 'string' }, description: 'Logins to assign.' },
        },
        ['title'],
      ),
      async handler(args) {
        const { repoPath } = await repoCtx(args);
        const issue = await client.request(`${repoPath}/issues`, {
          method: 'POST',
          body: { title: args.title, body: args.body, labels: args.labels, assignees: args.assignees },
        });
        return json({ number: issue.number, state: issue.state, html_url: issue.html_url });
      },
    },

    {
      name: 'github_comment_issue',
      description: 'Add a comment to an issue or pull request conversation. State-changing: confirm with the user first.',
      inputSchema: schema(
        {
          ...REPO_PROPS,
          issue_number: positiveInt('Issue or pull request number.'),
          body: { type: 'string', minLength: 1, description: 'Comment body in Markdown.' },
        },
        ['issue_number', 'body'],
      ),
      async handler(args) {
        const { repoPath } = await repoCtx(args);
        const comment = await client.request(`${repoPath}/issues/${args.issue_number}/comments`, {
          method: 'POST',
          body: { body: args.body },
        });
        return json({ id: comment.id, html_url: comment.html_url });
      },
    },

    {
      name: 'github_list_prs',
      description: 'List pull requests filtered by state, base branch, and head branch.',
      inputSchema: schema({
        ...REPO_PROPS,
        state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open', description: 'Pull request state.' },
        base: { type: 'string', description: 'Base branch name.' },
        head: { type: 'string', description: 'Head branch, as "branch" (same repo) or "user:branch".' },
        sort: {
          type: 'string',
          enum: ['created', 'updated', 'popularity', 'long-running'],
          default: 'created',
          description: 'Sort field (descending).',
        },
        per_page: perPage(30),
      }),
      async handler(args) {
        const { owner, repoPath } = await repoCtx(args);
        const head = args.head && !args.head.includes(':') ? `${owner}:${args.head}` : args.head;
        const prs = await client.request(`${repoPath}/pulls`, {
          query: { state: args.state, base: args.base, head, sort: args.sort, direction: 'desc', per_page: args.per_page },
        });
        return json({
          count: prs.length,
          pull_requests: prs.map((p) => ({
            number: p.number,
            title: p.title,
            state: p.state,
            draft: p.draft,
            author: login(p.user),
            head: p.head?.ref,
            base: p.base?.ref,
            merged_at: p.merged_at,
            updated_at: p.updated_at,
            html_url: p.html_url,
          })),
        });
      },
    },

    {
      name: 'github_get_pr',
      description: 'Get a pull request with its body, merge state, size, changed files, and review summary.',
      inputSchema: schema({ ...REPO_PROPS, pull_number: positiveInt('Pull request number.') }, ['pull_number']),
      async handler(args) {
        const { repoPath } = await repoCtx(args);
        const base = `${repoPath}/pulls/${args.pull_number}`;
        const [pr, files, reviews] = await Promise.all([
          client.request(base),
          client.request(`${base}/files`, { query: { per_page: MAX_PR_FILES } }),
          client.request(`${base}/reviews`, { query: { per_page: 100 } }),
        ]);

        const latestByReviewer = new Map();
        for (const review of reviews) {
          if (review.state === 'PENDING') continue;
          latestByReviewer.set(login(review.user), review);
        }
        const reviewSummary = {};
        for (const review of latestByReviewer.values()) {
          reviewSummary[review.state] = (reviewSummary[review.state] || 0) + 1;
        }

        return json({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          draft: pr.draft,
          merged: pr.merged,
          mergeable: pr.mergeable,
          mergeable_state: pr.mergeable_state,
          author: login(pr.user),
          head: { ref: pr.head?.ref, sha: pr.head?.sha },
          base: { ref: pr.base?.ref },
          commits: pr.commits,
          additions: pr.additions,
          deletions: pr.deletions,
          changed_files: pr.changed_files,
          html_url: pr.html_url,
          body: clip(pr.body, BODY_MAX_CHARS),
          files: files.map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            ...(f.previous_filename ? { previous_filename: f.previous_filename } : {}),
          })),
          files_truncated: pr.changed_files > files.length,
          reviews: [...latestByReviewer.values()].map((r) => ({
            reviewer: login(r.user),
            state: r.state,
            submitted_at: r.submitted_at,
          })),
          review_summary: reviewSummary,
        });
      },
    },

    {
      name: 'github_get_pr_diff',
      description: 'Get the unified diff of a pull request, optionally only for one file. Large diffs are truncated with a notice.',
      inputSchema: schema(
        {
          ...REPO_PROPS,
          pull_number: positiveInt('Pull request number.'),
          file_path: { type: 'string', description: 'Only return the diff for this file path.' },
          max_chars: {
            type: 'integer',
            minimum: 1000,
            maximum: 60000,
            default: 30000,
            description: 'Maximum characters returned (1000-60000, default 30000).',
          },
        },
        ['pull_number'],
      ),
      async handler(args) {
        const { repoPath } = await repoCtx(args);
        const diff = await client.request(`${repoPath}/pulls/${args.pull_number}`, {
          accept: 'application/vnd.github.v3.diff',
          raw: true,
          maxChars: 0,
        });

        if (!args.file_path) return truncateText(diff, args.max_chars) || 'The pull request has no diff.';

        const section = extractFileDiff(diff, args.file_path);
        if (!section) {
          const paths = diffFilePaths(diff);
          throw new GitHubError(
            `No diff found for "${args.file_path}" in pull request #${args.pull_number}. ` +
              `Changed files: ${paths.slice(0, 50).join(', ') || 'none'}${paths.length > 50 ? ', ...' : ''}`,
          );
        }
        return truncateText(section, args.max_chars);
      },
    },

    {
      name: 'github_create_pr',
      description: 'Open a pull request. Base defaults to the repository default branch. State-changing: confirm with the user first.',
      inputSchema: schema(
        {
          ...REPO_PROPS,
          title: { type: 'string', minLength: 1, description: 'Pull request title.' },
          head: { type: 'string', minLength: 1, description: 'Branch with the changes ("branch" or "user:branch").' },
          base: { type: 'string', description: 'Target branch. Defaults to the repository default branch.' },
          body: { type: 'string', description: 'Pull request description in Markdown.' },
          draft: { type: 'boolean', default: false, description: 'Open as a draft.' },
        },
        ['title', 'head'],
      ),
      async handler(args) {
        const { repoPath } = await repoCtx(args);
        let { base } = args;
        if (!base) base = (await client.request(repoPath)).default_branch;
        const pr = await client.request(`${repoPath}/pulls`, {
          method: 'POST',
          body: { title: args.title, head: args.head, base, body: args.body, draft: args.draft },
        });
        return json({ number: pr.number, draft: pr.draft, head: pr.head?.ref, base: pr.base?.ref, html_url: pr.html_url });
      },
    },

    {
      name: 'github_review_pr',
      description:
        'Submit a pull request review (APPROVE, REQUEST_CHANGES, or COMMENT) with optional inline comments. ' +
        'State-changing: confirm the event and text with the user first.',
      inputSchema: schema(
        {
          ...REPO_PROPS,
          pull_number: positiveInt('Pull request number.'),
          event: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'], description: 'Review action.' },
          body: { type: 'string', description: 'Review summary. Required for REQUEST_CHANGES and for COMMENT without inline comments.' },
          comments: {
            type: 'array',
            description: 'Inline comments on lines of the diff.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', minLength: 1, description: 'File path relative to the repository root.' },
                line: positiveInt('Line number in the file the comment applies to.'),
                side: { type: 'string', enum: ['LEFT', 'RIGHT'], description: 'LEFT for deleted lines, RIGHT (default) for added or context lines.' },
                body: { type: 'string', minLength: 1, description: 'Comment text.' },
              },
              required: ['path', 'line', 'body'],
            },
          },
        },
        ['pull_number', 'event'],
      ),
      async handler(args) {
        const hasBody = Boolean(args.body && args.body.trim());
        const comments = args.comments || [];
        if (args.event === 'REQUEST_CHANGES' && !hasBody) {
          throw new GitHubError('A body is required when requesting changes.');
        }
        if (args.event === 'COMMENT' && !hasBody && comments.length === 0) {
          throw new GitHubError('A COMMENT review needs a body or at least one inline comment.');
        }

        const { repoPath } = await repoCtx(args);
        const review = await client.request(`${repoPath}/pulls/${args.pull_number}/reviews`, {
          method: 'POST',
          body: {
            event: args.event,
            body: hasBody ? args.body : undefined,
            comments: comments.length
              ? comments.map((c) => ({ path: c.path, line: c.line, side: c.side || 'RIGHT', body: c.body }))
              : undefined,
          },
        });
        return json({ id: review.id, state: review.state, html_url: review.html_url });
      },
    },

    {
      name: 'github_list_workflow_runs',
      description: 'List recent GitHub Actions workflow runs, optionally filtered by branch and status.',
      inputSchema: schema({
        ...REPO_PROPS,
        branch: { type: 'string', description: 'Branch name.' },
        status: {
          type: 'string',
          enum: [
            'completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale',
            'success', 'timed_out', 'in_progress', 'queued', 'requested', 'waiting', 'pending',
          ],
          description: 'Run status or conclusion.',
        },
        per_page: perPage(15),
      }),
      async handler(args) {
        const { repoPath } = await repoCtx(args);
        const data = await client.request(`${repoPath}/actions/runs`, {
          query: { branch: args.branch, status: args.status, per_page: args.per_page },
        });
        const runs = (data.workflow_runs || []).map((r) => ({
          id: r.id,
          workflow: r.name,
          title: r.display_title,
          branch: r.head_branch,
          event: r.event,
          status: r.status,
          conclusion: r.conclusion,
          attempt: r.run_attempt,
          head_sha: r.head_sha,
          created_at: r.created_at,
          html_url: r.html_url,
        }));
        return json({ total_count: data.total_count, runs });
      },
    },

    {
      name: 'github_get_workflow_logs',
      description:
        'List the jobs of a workflow run with their failed steps, and return the last lines of the logs of failed jobs.',
      inputSchema: schema(
        {
          ...REPO_PROPS,
          run_id: positiveInt('Workflow run ID.'),
          tail_lines: {
            type: 'integer',
            minimum: 10,
            maximum: 1000,
            default: 120,
            description: 'Number of log lines to return per failed job (10-1000, default 120).',
          },
        },
        ['run_id'],
      ),
      async handler(args) {
        const { repoPath } = await repoCtx(args);
        const data = await client.request(`${repoPath}/actions/runs/${args.run_id}/jobs`, { query: { per_page: 100 } });
        const jobs = data.jobs || [];
        const failed = jobs.filter((j) => FAILED_CONCLUSIONS.has(j.conclusion));

        const summary = {
          run_id: args.run_id,
          total_jobs: jobs.length,
          failed_jobs: failed.length,
          jobs: jobs.map((j) => ({
            id: j.id,
            name: j.name,
            status: j.status,
            conclusion: j.conclusion,
            failed_steps: (j.steps || []).filter((s) => s.conclusion === 'failure').map((s) => s.name),
            html_url: j.html_url,
          })),
        };

        const sections = [];
        for (const job of failed.slice(0, MAX_LOG_JOBS)) {
          try {
            const log = await client.downloadText(`${repoPath}/actions/jobs/${job.id}/logs`, { maxChars: 0 });
            const tail = truncateText(tailLines(log, args.tail_lines), LOG_MAX_CHARS, { keep: 'tail' });
            sections.push(`--- ${job.name} (job ${job.id}, ${job.conclusion}): last ${args.tail_lines} lines ---\n${tail}`);
          } catch (err) {
            sections.push(`--- ${job.name} (job ${job.id}): logs unavailable: ${err.message} ---`);
          }
        }
        if (failed.length > MAX_LOG_JOBS) {
          sections.push(`Logs shown for the first ${MAX_LOG_JOBS} of ${failed.length} failed jobs.`);
        }

        const tail = sections.length ? sections.join('\n\n') : 'No failed jobs in this run.';
        return `${json(summary)}\n\n${tail}`;
      },
    },

    {
      name: 'github_rerun_workflow',
      description: 'Re-run a workflow run, by default only its failed jobs. State-changing: confirm with the user first.',
      inputSchema: schema(
        {
          ...REPO_PROPS,
          run_id: positiveInt('Workflow run ID.'),
          failed_only: { type: 'boolean', default: true, description: 'Re-run only failed jobs (default true).' },
        },
        ['run_id'],
      ),
      async handler(args) {
        const { repoPath } = await repoCtx(args);
        const action = args.failed_only ? 'rerun-failed-jobs' : 'rerun';
        await client.request(`${repoPath}/actions/runs/${args.run_id}/${action}`, { method: 'POST' });
        return json({ rerun_requested: true, run_id: args.run_id, mode: args.failed_only ? 'failed_jobs' : 'all_jobs' });
      },
    },

    {
      name: 'github_search_code',
      description:
        'Search code on GitHub. Scoped to one repository when owner and repo are given, or when scope_current_repo is true.',
      inputSchema: schema(
        {
          ...REPO_PROPS,
          query: { type: 'string', minLength: 1, description: 'GitHub code search query, e.g. "parseConfig language:js".' },
          scope_current_repo: {
            type: 'boolean',
            default: false,
            description: 'Limit the search to the repository detected from cwd.',
          },
          per_page: perPage(15),
        },
        ['query'],
      ),
      async handler(args) {
        let q = args.query.trim();
        if (!/(^|\s)repo:/.test(q) && (args.owner || args.repo || args.scope_current_repo)) {
          const { owner, repo } = await repoCtx(args);
          q += ` repo:${owner}/${repo}`;
        }
        const data = await client.request('/search/code', {
          query: { q, per_page: args.per_page },
          accept: 'application/vnd.github.text-match+json',
        });
        return json({
          query: q,
          total_count: data.total_count,
          incomplete_results: data.incomplete_results,
          items: (data.items || []).map((item) => ({
            path: item.path,
            repository: item.repository?.full_name,
            html_url: item.html_url,
            matches: (item.text_matches || []).map((m) => clip(m.fragment, 300)),
          })),
        });
      },
    },

    {
      name: 'github_create_release',
      description:
        'Create a release. Defaults to a draft so the maintainer can review it before publishing. ' +
        'State-changing: confirm with the user first.',
      inputSchema: schema(
        {
          ...REPO_PROPS,
          tag_name: { type: 'string', minLength: 1, description: 'Tag for the release, e.g. "v1.2.0".' },
          name: { type: 'string', description: 'Release title.' },
          body: { type: 'string', description: 'Release notes in Markdown.' },
          target_commitish: { type: 'string', description: 'Branch or commit SHA for a new tag. Defaults to the default branch.' },
          draft: { type: 'boolean', default: true, description: 'Create as draft (default true).' },
          prerelease: { type: 'boolean', default: false, description: 'Mark as prerelease.' },
          generate_release_notes: {
            type: 'boolean',
            default: false,
            description: 'Let GitHub generate notes from merged pull requests.',
          },
        },
        ['tag_name'],
      ),
      async handler(args) {
        const { repoPath } = await repoCtx(args);
        const release = await client.request(`${repoPath}/releases`, {
          method: 'POST',
          body: {
            tag_name: args.tag_name,
            name: args.name,
            body: args.body,
            target_commitish: args.target_commitish,
            draft: args.draft,
            prerelease: args.prerelease,
            generate_release_notes: args.generate_release_notes,
          },
        });
        return json({
          id: release.id,
          tag_name: release.tag_name,
          name: release.name,
          draft: release.draft,
          prerelease: release.prerelease,
          html_url: release.html_url,
        });
      },
    },
  ];

  return tools;
}

// Runs a tool and converts the outcome to an MCP tools/call result.
export async function runTool(tool, rawArgs) {
  const { args, error } = prepareArgs(tool.inputSchema, rawArgs);
  if (error) return { content: [{ type: 'text', text: `Invalid arguments: ${error}` }], isError: true };
  try {
    const text = await tool.handler(args);
    return { content: [{ type: 'text', text: String(text) }] };
  } catch (err) {
    const message = err instanceof GitHubError ? err.message : `Unexpected error: ${err?.message || String(err)}`;
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}
