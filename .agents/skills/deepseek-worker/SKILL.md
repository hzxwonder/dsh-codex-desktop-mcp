---
name: deepseek-worker
description: Delegate cohesive engineering work to DSH after Codex settles goals and interfaces. Codex retains research, creative choices, high-risk decisions, integration and acceptance.
---

# Codex and DSH collaboration

Use the configured DSH provider and model. DSH API calls have separate fees. Keep the current Codex model. Do not substitute a model or call its API directly.

## Choose the deliverable

Codex owns research questions, scientific comparisons, creativity, aesthetics, important writing, architecture, high-risk changes, integration and acceptance. A complex parent can contain routine implementation. Do not keep all implementation in Codex because the parent is complex or scientific.

Before substantial implementation, identify a useful engineering deliverable with settled inputs, outputs and checks. Prefer DSH implementation over an advisory-only review when such a deliverable exists. Otherwise state the concrete obstacle and proceed directly. Instant answers, obvious edits and existing deterministic commands stay in Codex when delegation adds no value.

Choose a cohesive deliverable, not a line count or file count. A planner with its queue and tests, a statistical summary with tests, or a batch runner with receipts can each be one task. Keep coupled helpers together. Split when parts need different unresolved decisions, independent interfaces or separate write locations. Do not split every function or delegate the entire research project. DSH chooses local implementation details within the settled contract.

After settling decisions, check the remaining engineering work too. Runners, statistics, table generation and plot rendering can be delegated against a fixed protocol. Retain scientific interpretation and visual acceptance in Codex. Do not retain all support code merely because one implementation was already delegated. Group coupled work; delegate independent deliverables concurrently when profitable.

## Give an executable contract

Provide relevant paths and facts. Do not implement first.

- Goal: observable result and purpose.
- Interface: exact signatures, data shapes, units, errors and one example. Name reusable code.
- Scope: allowed files, preserved behavior and decisions DSH may make. Codex retains scientific and product choices.
- Acceptance: known-answer cases, edge cases, resource limits and focused commands. Do not require a favored method to win.
- Receipt: changed paths, concise choices, exact checks/results and remaining limits. Return paths instead of full files.

State assumptions that change results. If a material requirement is missing or conflicting, DSH inspects relevant inputs and reports the gap before editing. Codex resolves it in the same session. Do not paste supervisor rules or the whole chat.

## Run and resume

Use an authorized absolute project_root and keep cwd inside it. Select a supported thinking_effort explicitly each time. Choose high for bounded reasoning, low for modest work, or off when appropriate or required. Do not invent aliases.

The bridge supports two concurrent runs per server. Independent writers need isolated project copies, each with a distinct project_root inside the authorized workspace. Readers may share a location. Never read a domain while another worker writes it. The server rejects overlapping write roots, one shared Git repository and simultaneous use of one session. These checks are not an ACL or a cross-server lock. Keep your aggregate concurrency at two.

Freeze shared inputs. Assign one writer per copy. Use separate cards. Prefer delegate_parallel_to_deepseek for two independent tasks in one call. If that tool is unavailable, use concurrent single-task calls with Promise.allSettled when supported. Inspect every outcome. If concurrent tool calls are unavailable, use separate coordinating agents only when authorized. Do not label serial calls as parallel. Codex integrates accepted artifacts after workers finish and does not duplicate their implementation.

Resume related corrections with the returned session_id, same root and same actual cwd. A fresh card does not create a new DSH session. Allow one corrective continuation. If acceptance still fails, Codex takes over. Inspect partial files after cancellation or timeout. Do not restart in a new DSH session to reset this limit.

Show an inline card before each call and pass progress_id when available. Never automatically open a browser/sidebar or read cards, read_dsh_progress, raw logs or hidden reasoning. Logs and view_token remain in UI-only _meta. get_dsh_monitor requires an explicit request.

## Review without reimplementation

Check status, exit_code, output_source, session_id, assistant_seq and turn. Accept only the latest durable session answer. completed is not acceptance. Inspect changed files and interfaces, then run a focused independent check. Reuse valid evidence. Do not rewrite accepted code for style. Corrections give the failed check, observed result, required behavior and allowed scope. Worker tests are not the sole oracle. Add a small independent case at an interface or exclusion boundary. For ignored inputs, check that adding ignored categories does not change the selected output. Keep this check separate from worker-authored tests.

For experiments, Codex freezes the protocol and an independent oracle. DSH can implement planners, data preparation, runners and statistics against that protocol. Codex verifies metrics, stopping rules, data separation and conclusions. Retain negative and censored results. Do not alter the protocol to make code pass.

Record first-pass acceptance, corrective calls, Codex repairs and tested limits. Use measured token usage only when available. Code ownership and elapsed time are proxies, not proof of token/cost savings. Keep stable acceptance checks and add a held-out case before widening the boundary.

Honor explicit worker choices, permissions and network limits. No-network includes DSH API calls; no-web-research alone does not forbid an authorized model call. If unavailable, explain and complete permitted work directly. File lists are instructions, not access controls. Never send secrets. Use dsh-codex-desktop-mcp doctor for setup failures. A fresh connection does not reload an existing App connection.
