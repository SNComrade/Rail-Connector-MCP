# Rail Connector Review Prompt

Read this reference when building the prompt sent through `submit_prompt`.

## Template

```text
You are acting as an independent reviewer for this repository.

Repository path:
{absolute_repo_path}

Review objective:
{objective}

Current branch and scope:
{branch_and_scope}

Important local context from Codex:
{brief_status_diff_tests_or_files}

Constraints:
- Report only. Do not edit files, commit, push, install packages, change
  configuration, or write artifacts unless the user explicitly gives a report
  path.
- Use read-only inspection commands only. If a command may write build output,
  cache files, dependencies, or external state, skip it and say so.
- Deliver the complete report directly in this response. Do not enter or exit
  a plan workflow, write a plan file, or ask for approval to continue.
- Focus on high-confidence, actionable findings. Do not lower the quality bar
  just to produce issues.
- Prefer file and line references for every actionable finding.
- If you are blocked by missing tools, auth, session limits, or unclear scope,
  report the blocker plainly.
- Do not delegate or launch a dynamic workflow unless this prompt explicitly
  authorizes it. If parallel review is authorized without caller-supplied
  bounds, use at most 3 workflow agents, one pass, no recursive delegation, at
  most 5 findings, 10 minutes, and 200k aggregate tokens. Stop and synthesize
  when any bound is reached.

Return this structure:
1. Findings
   - Severity
   - File:line
   - Issue
   - Impact
   - Suggested fix
2. Open questions or assumptions
3. Checks run or skipped
4. Short overall assessment

If there are no actionable findings, say that directly and list the main
residual risks or test gaps.
```

## Prompt Notes

- Keep the prompt specific to the user's requested review. Avoid asking Claude
  for a broad repo audit when the user wants one change reviewed.
- Include enough local status for Claude to orient quickly, but let Claude
  inspect the repo itself from the provided `cwd`.
- Ask for final-quality review output, not a performance report about Claude.
- Keep effort, Ultracode, and permission selection in the
  `start_remote_control` call. Do not use prompt wording as a substitute for
  launch controls. A leading `ultracode:` sent with native-Windows
  `pasteMode: "keyword"` requests a workflow only; it changes no effort,
  permissions, or workspace trust, and session Ultracode remains a separate
  launch control. A report-only prompt can run with
  explicitly requested Ultracode or bypass posture, but the reviewer must
  preserve the no-edit constraints, report the elevated posture, and never
  elevate independently.
- Pass `disallowedTools: ["Edit", "Write", "NotebookEdit"]`, keep
  `trustWorkspace: false` unless trust was explicitly authorized, leave
  `promptSuggestions` unset (default `false`) so a newly launched Claude starts
  with prompt suggestions off, and verify the repository/index before and after
  the turn. Suggestion text can still appear in some cases: a Claude settings
  `env` entry or wrapper can override the setting, Claude before 2.1.238
  ignores it, and a reused session keeps the environment it was launched with.
  The MCP cannot tell that text from a draft, so it blocks prompts
  (`active_input_not_empty`) and graceful stop (`awaiting_input`).
- State that those flags constrain built-in tools only. Connected MCP and
  connector tools can remain available, so inspect the effective roster when
  possible and use an isolated worktree or read-only copy for hard write
  isolation.
- Prefer `permissionMode: "dontAsk"` for report-only inspection when Claude
  advertises it. If a compatibility fallback uses `plan`, never approve the
  plan or implementation; restart the review in `dontAsk` when possible. A
  keyword workflow review under `dontAsk` also needs a Workflow allowance at
  launch; without one Claude denies the workflow (seen live). The verified
  allowance is `tools: ["Workflow"]` plus `allowedTools: ["Workflow"]`, which
  leaves Workflow as the only built-in tool, so a review that reads code must
  also list its read tools (not verified); `allowedTools` alone is not
  verified.
- If Claude previously gave a weak answer, ask it to perform a fresh pass using
  the structure above instead of asking it to defend the earlier result.
- Keyword mode needs an empty composer: a draft or paste placeholder returns
  `preflight_blocked` even with `force: true`, and nothing is sent. Do not ask
  Claude to call `TaskOutput` on CLI 2.1.289, which has no such tool; there a
  finished workflow is released by Claude's own task notification or, in a
  fresh native-Windows conversation, the workflow snapshot.
