# MastekHR: how this repository is kept in step with the Workbench

`adlc.mjs` (in the repository root) pulls this project's policies, guardrails, context and your tasks from the Workbench and writes them here.

| Command | What it does |
|---|---|
| `node adlc.mjs status` | Says whether this repository is up to date, and which task you started. |
| `node adlc.mjs pull` | Brings it up to date. Restores any locked policy file that was edited. |
| `node adlc.mjs watch` | Checks every few minutes and pulls when something changed. `watch --daemon` runs it in the background; `watch --stop` stops it. |
| `node adlc.mjs tasks` | Lists your tasks. |
| `node adlc.mjs task start <id>` | Marks the task you are working on (this machine only). |
| `node adlc.mjs hooks install` | Optional. Adds git hooks that put the task trailers (`ADLC-Task`, `ADLC-Story`, `ADLC-Agent`, `ADLC-Context`) on your commits. |
| `node adlc.mjs evaluate` | What a pull request is checked against (also run by CI): locked files intact, task trailers on every commit, no secrets added, test results. `--report` sends the result to the Workbench with a CI token. Templates: `.workbench/ci/`. |
| `node adlc.mjs mcp` | A small Claude Code tool server (current task, your tasks, the rules). Add it with: `claude mcp add adlc -- node adlc.mjs mcp`. |
| `node adlc.mjs telemetry show` | Prints exactly what this machine is waiting to report. `telemetry off` stops reporting here. |

## What this machine reports back

Facts about the work, as counts and ids: that you pulled and which bundle you hold, the task you started, whether a locked file was edited, that a commit was made (its short id, how many files and lines, whether it carries the task trailers), and how Claude Code was used (the model, token counts, tool counts, how long).

It never reports source code, diffs, prompts, Claude's answers, transcripts, file contents or commit messages. The Workbench refuses a report that holds any of them. The figures are labelled as reported by your machine.

## How firmly these rules hold in Claude Code

Strength of this file: Block is ADVISORY. Across its 8 controls: 4 advisory, 4 not possible. Not yet tested on a real installation. The files in this repository are guidance for Claude. They do not stop Claude or a developer on their own.

| Control | Strength | What would enforce it |
|---|---|---|
| Block: stop a forbidden action | Advisory | Managed settings permissions.deny, or a PreToolUse hook that exits 2 (a hook that times out blocks only with onFailure: block). The Workbench does not generate these yet. |
| Warn: tell the user and carry on | Advisory | This file is enough. |
| Log: record that it happened | Not possible | The telemetry hooks from the developer sync (adlc.mjs hooks), which always exit 0, or telemetry set in managed settings. |
| Keep secrets and named files out of reach | Advisory | permissions.deny rules such as Read(./secrets/**) in managed settings, with allowManagedPermissionRulesOnly. |
| Limit which MCP servers and plugins can be used | Not possible | allowManagedMcpServersOnly and strictKnownMarketplaces in managed settings. |
| Limit which models and effort can be used | Not possible | availableModels and maxEffortLevel in managed settings; per-group limits need the Claude apps gateway. |
| Require the organisation's sign-in and a minimum version | Not possible | forceLoginOrgUUID and requiredMinimumVersion in managed settings. |
| Show which policy version is in force | Advisory | Reading the effective settings back (gap register action 5). |

Locked (do not edit; Enterprise Governance owns them):

- `.claude/skills/project-policy/`
- `.workbench/policy.lock.json`
- `.workbench/CODEOWNERS.snippet`

Your token is in `.workbench/local.json`, which is kept out of git. Do not share it or commit it.
