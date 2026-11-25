---
name: release-notes
description: Drafts release notes and a draft GitHub release with the github-kit MCP tools. Collects the pull requests merged since the last release, groups them into New, Fixes, and Breaking Changes, and creates the release as a draft so the maintainer reviews it before publishing. Use when the user asks for release notes, a changelog entry, or to prepare a release.
---

# Release notes

## Repository context

Pass `cwd` with the absolute path of the current workspace on every github-kit call so owner and repo are resolved from its `origin` remote. Pass `owner` and `repo` instead for another repository.

## Steps

1. Find the previous release in the workspace:
   - `git fetch --tags`, then `git describe --tags --abbrev=0` for the last tag.
   - `git log -1 --format=%cI <tag>` for its date.
   - If there are no tags, ask the user where the release should start.
2. Call `github_get_repo` to get `default_branch`.
3. Call `github_list_prs` with `state: "closed"`, `base` set to the default branch, `sort: "updated"`, and `per_page: 50`. Keep only pull requests with `merged_at` after the last tag date.
4. Cross-check with `git log <tag>..HEAD --oneline` in the workspace. If commits reference pull requests missing from the list (more than 50 changed), fetch them with `github_get_pr` or tell the user the list may be incomplete.
5. Open unclear pull requests with `github_get_pr` and read the description.
6. Group the changes:
   - Breaking Changes: removed or renamed APIs, changed defaults or behavior, required migrations. Add one line on what users must do.
   - New: features and user-visible improvements.
   - Fixes: bug fixes.
   - Maintenance: CI, refactors, and dependency bumps. Keep it short or leave it out when it does not affect users.
7. Suggest the next version with semantic versioning: breaking changes bump major, new features bump minor, fixes only bump patch. Confirm the tag name with the user.
8. Write the notes in Markdown:
   - One heading per non-empty group.
   - One line per change: a short description, then `(#<number>)` and `@<author>`.
9. Show the draft. After explicit confirmation call `github_create_release` with `tag_name`, `name`, and `body`. Keep `draft: true` (the default). Set `target_commitish` to the default branch when the tag does not exist yet. If the user prefers GitHub generated notes, set `generate_release_notes: true` and pass only a short `body` or none.
10. Share the draft URL and tell the user to publish it on GitHub after review.

## Notes

- Never set `draft: false` unless the user explicitly asks to publish immediately.
- Mark `prerelease: true` for versions such as `v2.0.0-rc.1`.
- Describe changes from the user's point of view, not commit by commit.
