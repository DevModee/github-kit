---
name: pr-review
description: Reviews a GitHub pull request with the github-kit MCP tools. Fetches the pull request and its diff, checks correctness, edge cases, security, and tests, presents the findings, and submits a review only after the user confirms. Use when the user asks to review, check, or give feedback on a pull request.
---

# Pull request review

## Repository context

Pass `cwd` with the absolute path of the current workspace on every github-kit call so owner and repo are resolved from its `origin` remote. Pass `owner` and `repo` instead when the pull request belongs to another repository.

## Steps

1. Pick the pull request. If the user did not give a number, call `github_list_prs` with `state: "open"` and `sort: "updated"`, show the list, and ask which one to review.
2. Call `github_get_pr` with `pull_number`. Note the base and head branches, draft flag, mergeable state, size, changed files, and existing reviews.
3. Read the diff with `github_get_pr_diff`:
   - Small pull request: one call without `file_path`.
   - Large pull request or a `[truncated` notice in the output: one call per relevant file with `file_path`.
   - Skip generated files, lockfiles, and vendored code unless they are the point of the change.
4. When the workspace has the code, open the surrounding functions and callers to confirm behavior instead of judging the diff in isolation.
5. Check each change for:
   - Correctness: logic errors, wrong conditions, off-by-one, unhandled errors, race conditions.
   - Edge cases: empty or null input, large input, unicode, timezones, retries.
   - Security: injection, missing authorization checks, secrets in code or logs, unsafe deserialization, path traversal.
   - Tests: new behavior covered, changed behavior updated, no tests deleted without reason.
   - Compatibility: public API, config, database schema, or CLI flag changes that break existing users.
6. Present the review to the user:
   - One or two sentences on what the pull request does.
   - Findings ordered by severity, each with `path:line`, the problem, and a concrete fix.
   - The suggested event: `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`.
7. Ask the user to confirm the event and the text. Do not submit anything without explicit confirmation.
8. Call `github_review_pr` with the confirmed `event`, `body`, and inline `comments`:
   - `path` relative to the repository root.
   - `line` is the line number in the new version of the file, with `side: "RIGHT"`.
   - Use `side: "LEFT"` with the old line number for comments on deleted lines.
9. Share the review URL returned by the tool.

## Notes

- Inline comments must target lines that appear in the diff. GitHub rejects other lines with a 422 error; move that feedback to the review body.
- GitHub does not allow approving your own pull request. Use `COMMENT` in that case.
- `REQUEST_CHANGES` requires a body.
- Keep comments specific and actionable. Leave out generic praise and style nits already enforced by linters.
