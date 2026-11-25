# GitHub Kit

GitHub plugin for [Google Antigravity](https://antigravity.google). It bundles:

- An MCP server with 16 tools for pull requests, issues, code review, GitHub Actions logs, code search, and releases.
- 4 skills: pull request review, CI triage, issue triage, and release notes.
- A `PreToolUse` hook that blocks or asks before destructive git commands.
- Plugin rules that keep tokens out of output and require confirmation for state-changing actions.

The server and the hook use only Node.js built-ins. There is nothing to `npm install`.

## Requirements

- Node.js 20 or newer.
- A GitHub token, resolved in this order:
  1. `GITHUB_TOKEN`
  2. `GH_TOKEN`
  3. `gh auth token` from the [GitHub CLI](https://cli.github.com) (run `gh auth login` once)

Token permissions used by the tools:

| Access | Fine-grained permission | Classic scope |
|--------|-------------------------|---------------|
| Read repositories, pull requests, issues, Actions | Metadata, Contents, Pull requests, Issues, Actions: read | `repo` (private) or none (public) |
| Comment, create issues and pull requests, review | Issues, Pull requests: write | `repo` / `public_repo` |
| Re-run workflows | Actions: write | `repo` / `public_repo` |
| Create releases | Contents: write | `repo` / `public_repo` |

## Installation

From GitHub:

```bash
agy plugin install https://github.com/DevModee/github-kit
```

From a local clone:

```bash
git clone https://github.com/DevModee/github-kit.git
agy plugin validate --strict ./github-kit
agy plugin install ./github-kit
agy plugin list
```

## Configuration

| Variable | Purpose |
|----------|---------|
| `GITHUB_TOKEN` / `GH_TOKEN` | Token used for API calls. Optional when the GitHub CLI is logged in. |
| `GITHUB_API_URL` | API base URL. Defaults to `https://api.github.com`. Set it for GitHub Enterprise Server (`https://<host>/api/v3`) or GHE.com (`https://api.<subdomain>.ghe.com`). |

Repository-scoped tools accept optional `owner`, `repo`, and `cwd`. When `owner` and `repo` are omitted, they are read from the `origin` remote of `cwd` (HTTPS and SSH remotes are supported). The skills pass the workspace path as `cwd`. If the server process runs inside the plugin directory and no `cwd` is given, the tools return an error instead of guessing the repository.

## Tools

State-changing tools are marked with **write**. The plugin rules tell the agent to confirm them with you first.

| Tool | What it does | Required inputs |
|------|--------------|-----------------|
| `github_whoami` | Authenticated user and remaining core and search rate limits | none |
| `github_get_repo` | Default branch, visibility, stars, forks, open issues, topics | none |
| `github_list_issues` | Issues filtered by `state`, `labels`, `assignee` (pull requests excluded) | none |
| `github_get_issue` | Issue body, labels, assignees, and the 20 most recent comments | `issue_number` |
| `github_create_issue` | **write** Create an issue with optional labels and assignees | `title` |
| `github_comment_issue` | **write** Comment on an issue or pull request conversation | `issue_number`, `body` |
| `github_list_prs` | Pull requests filtered by `state`, `base`, `head`, `sort` | none |
| `github_get_pr` | Pull request metadata, merge state, changed files, latest review per reviewer | `pull_number` |
| `github_get_pr_diff` | Unified diff, optionally for one `file_path`, truncated at `max_chars` (default 30000) | `pull_number` |
| `github_create_pr` | **write** Open a pull request; `base` defaults to the default branch | `title`, `head` |
| `github_review_pr` | **write** Submit `APPROVE`, `REQUEST_CHANGES`, or `COMMENT` with inline comments | `pull_number`, `event` |
| `github_list_workflow_runs` | Recent Actions runs filtered by `branch` and `status` | none |
| `github_get_workflow_logs` | Jobs, failed steps, and the last `tail_lines` (default 120) of failed job logs | `run_id` |
| `github_rerun_workflow` | **write** Re-run failed jobs (default) or the whole run | `run_id` |
| `github_search_code` | Code search with text fragments, optionally scoped to one repository | `query` |
| `github_create_release` | **write** Create a release, as a draft by default | `tag_name` |

Output limits keep results inside the model context: diffs are capped at 60000 characters, issue and pull request bodies at 20000, comments at 4000, and job logs at 20000 per job. Every cut adds a `[truncated: ...]` notice.

## Skills

| Skill | Use it to |
|-------|-----------|
| `pr-review` | Review a pull request and submit the review after you confirm the event and text. |
| `ci-triage` | Find the failing run, read the failed job logs, locate the cause in the workspace, and fix or re-run. |
| `issue-triage` | Inspect issues, check for duplicates and root cause, and post a triage comment after confirmation. |
| `release-notes` | Group merged pull requests since the last tag and create a draft release. |

## Git safety hook

`hooks/git-guard.mjs` runs before every `run_command` call. It parses the command line (quotes, `&&`, `;`, pipes, `git -C`, environment prefixes, and `bash -c` / `powershell -Command` / `cmd /c` wrappers) and returns one decision:

| Decision | Commands |
|----------|----------|
| `deny` | Force push to `main` or `master` (`--force`, `-f`, `+main` refspec, `--mirror`, `--force --all`). Deleting `main` or `master` (`push --delete`, `push :main`, `branch -D`). |
| `force_ask` | Force push to any other branch. `--force-with-lease` to `main`/`master`. `git reset --hard`. `git clean -f`. |
| `allow` | Everything else, including `--force-with-lease` to feature branches and `git clean -n`. |

For `git push --force` without a refspec, the hook reads the current branch with `git rev-parse`. If the payload cannot be parsed, the hook answers `allow` so it never blocks the agent by mistake.

## Security

- Tokens are never written to tool output, errors, or logs. Error messages do not repeat git remote URLs or signed log URLs.
- Actions log downloads follow GitHub's redirect manually and do not send the `Authorization` header to the storage host.
- Owner and repository names are validated before they are used in API paths.

## Development

```bash
npm run lint   # node --check on every module, JSON parse, em-dash check
npm test       # node:test suites for the client, server, tools, hook, and manifest
npm start      # run the MCP server on stdio
```

```text
plugin.json          manifest (Antigravity schema v1)
mcp_config.json      MCP server registration
hooks.json           PreToolUse hook registration
src/github.mjs       REST client, token and repository resolution
src/tools.mjs        tool schemas and handlers
src/server.mjs       JSON-RPC 2.0 stdio server
hooks/git-guard.mjs  git safety hook
skills/              workflow skills
rules/AGENTS.md      plugin rules
tests/               node:test suites
```

## License

[MIT](LICENSE)
