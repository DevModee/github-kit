---
name: ci-triage
description: Diagnoses failing GitHub Actions runs with the github-kit MCP tools. Finds the failed run, reads the logs of the failing jobs, maps the error to files in the workspace, proposes or applies a fix, and re-runs failed jobs only after the user confirms. Use when CI is red, a workflow or check failed, or the user asks why a build is failing.
---

# CI triage

## Repository context

Pass `cwd` with the absolute path of the current workspace on every github-kit call so owner and repo are resolved from its `origin` remote. Pass `owner` and `repo` instead for another repository.

## Steps

1. Find the run.
   - If the user gave a run URL, take the ID from `/actions/runs/<run_id>`.
   - Otherwise get the branch with `git branch --show-current` in the workspace (or use the branch the user named) and call `github_list_workflow_runs` with `branch`, `status: "failure"`, and `per_page: 5`. Use the most recent run unless the user points to another.
2. Call `github_get_workflow_logs` with `run_id`. Read `failed_steps` for each job and the log tail of each failed job.
   - If the real error is above the tail, call it again with a larger `tail_lines` (up to 1000).
   - If logs are reported as unavailable, the run may still be in progress or the logs expired; say so and stop.
3. Classify the failure:
   - Test failure: assertion, snapshot, timeout inside a test.
   - Build or type error.
   - Lint or formatting.
   - Dependency or install error: lockfile drift, registry outage, version conflict.
   - Infrastructure or flaky: runner lost, network errors, rate limits, cancelled by timeout.
4. Locate the cause in the workspace.
   - Open the files and lines named in the log.
   - Compare the run `head_sha` with `git rev-parse HEAD`. If they differ, tell the user the local checkout is not the code that failed.
   - Read the failing step in `.github/workflows/*.yml` to get the exact command and environment.
5. Reproduce locally when it is cheap, using the same command as the failing step.
6. Report to the user:
   - Run link, failing job and step.
   - Root cause in one or two sentences.
   - The few log lines that prove it.
   - The proposed fix.
7. Apply the fix only if the user agrees, then run the same local check again and show the result.
8. Re-run only for infrastructure or flaky failures with no code change. Ask first, then call `github_rerun_workflow` with `run_id` (`failed_only` defaults to `true`). When a fix is pushed, the new commit triggers a fresh run, so no re-run is needed.

## Notes

- Do not re-run repeatedly to get a green check. A second identical failure is not flaky.
- Do not disable, skip, or delete failing tests as a fix unless the user explicitly asks for it.
