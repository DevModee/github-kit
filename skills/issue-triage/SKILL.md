---
name: issue-triage
description: Triages GitHub issues with the github-kit MCP tools. Lists or inspects issues, checks the codebase for the root cause and for duplicates, drafts a concise triage comment, and posts it only after the user confirms. Use when the user asks to triage, investigate, prioritize, or reply to issues.
---

# Issue triage

## Repository context

Pass `cwd` with the absolute path of the current workspace on every github-kit call so owner and repo are resolved from its `origin` remote. Pass `owner` and `repo` instead for another repository.

## Steps

1. Select the issues.
   - Specific issue: go to step 2 with its number.
   - Batch: call `github_list_issues` with `state: "open"` and filters the user asked for (`labels`, `assignee`). Propose an order: issues with no labels or assignee first, then the oldest, then those with the most comments.
2. Call `github_get_issue` with `issue_number`. Extract expected behavior, actual behavior, version, environment, reproduction steps, and exact error messages.
3. Look for duplicates. Call `github_list_issues` with `state: "all"` and `per_page: 50` (add a related label when there is one) and compare titles and symptoms. Open likely matches with `github_get_issue`.
4. Look for the root cause.
   - Search the local workspace for the error message, function names, and config keys from the issue.
   - Use `github_search_code` with `scope_current_repo: true` when the code is not checked out locally.
   - Check recent changes to the suspect files with `git log -p -- <path>` when the issue mentions a regression.
5. Classify the issue as one of:
   - Confirmed bug, with the file and line responsible.
   - Needs information, with the exact missing details.
   - Duplicate, with the original issue number.
   - Feature request.
   - Not a bug, with the reason.
6. Draft a comment:
   - What was checked and found, with file references.
   - The next step or the specific questions for the reporter.
   - No dates or promises about when it will be fixed.
7. Show the draft and the proposed labels to the user. Post with `github_comment_issue` only after explicit confirmation.
8. When the user wants a follow-up issue (for example, splitting a report), confirm title, body, and labels, then call `github_create_issue`.

## Notes

- github-kit does not edit labels, assignees, or issue state. List the suggested changes so the user can apply them on GitHub.
- Quote only the relevant part of logs in comments, and never include tokens, credentials, or private URLs.
