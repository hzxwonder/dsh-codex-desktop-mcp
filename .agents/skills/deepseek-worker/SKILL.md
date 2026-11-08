---
name: deepseek-worker
description: Use DSH for bounded work that benefits from local investigation, reasoning or implementation choices. Codex handles instant edits, creative/aesthetic/important/complex/high-risk work, prompt design and review.
---

# Codex and DSH collaboration

This skill is for Codex, which supervises the local DSH Harness. DSH uses the model API selected in setup and has separate fees. Keep the current Codex model/account and the configured DSH provider/model. Do not substitute another model or a direct API call.

## Choose by value

Codex directly completes tasks with an immediate, reliable solution and no need for exploration: a short factual answer, an obvious edit, a tiny standard example, or an existing deterministic command. Also keep work in Codex when delegation would reduce efficiency or completeness, or offer no clear benefit. Do not delegate merely because the task contains code or documentation.

Codex owns creative discussion, brainstorming, aesthetics and visual judgment, research direction, papers and important writing, complex/coupled architecture or implementation, unbounded diagnosis, security/authentication/payments/migrations, production-critical decisions, final review and publishing.

Delegate bounded, verifiable work that needs meaningful reading, local investigation, reasoning or implementation choices. Examples: inspect a small existing module, implement a specified behavior with several edge cases, investigate a localized non-critical defect, or reconcile multiple inputs into a checkable artifact. The goal must be clear even when DSH may explore how to implement it. For mixed tasks, Codex makes the important decisions and delegates suitable bounded parts. Batch compatible work with one acceptance contract. Do not duplicate implementation across agents.

Honor explicit user worker choices, project rules and permissions. No-network restrictions include the DSH API; no-web-research restrictions alone do not forbid an otherwise authorized model API. If delegation tools or authorization are unavailable, explain briefly and complete permitted work directly. Reuse this skill within the chat.

## Build the worker prompt

Give DSH only the relevant context. Use this compact contract, adapting the headings when useful:

- **Goal:** the observable result and why it is needed.
- **Known facts:** relevant files/interfaces, existing behavior and settled requirements. Distinguish facts from assumptions.
- **Scope:** allowed files, preserved behavior and prohibited changes.
- **Local choices:** what DSH may investigate or decide. Identify decisions reserved for Codex or the user.
- **Acceptance:** concrete examples, edge cases and focused check commands. State how each material requirement will be checked.
- **Receipt:** file paths, a brief account of meaningful choices, exact checks/results and unresolved questions. Return full code only when requested rather than stored in files.

If a missing or conflicting requirement could change the result, DSH should inspect relevant inputs and report the gap before editing. Do not ask DSH to infer unstated product behavior or wait for live clarification. Codex resolves final questions and resumes the same session. Do not copy this supervisor skill or the whole chat into the task.

## Call and resume

Use the authorized absolute project_root from active context or explicit user authorization. Never infer it from HOME, installation or history. Keep cwd inside the root; allow one workspace writer and serialize this server's calls. Use read-only unless edits need workspace-write. File lists are instructions, not access controls. The grant is not an independently verified Codex ACL; reads are not workspace-confined and writes can include DSH state/platform temporary paths. Never send secrets or expand permissions.

Select thinking_effort explicitly from the current tool schema on every call/resume. Use low for modest work, high for bounded reasoning, or off when deliberate or the only supported value. Unknown metadata exposes only off; this is not proof that the model cannot reason. Never use aliases or coerce unsupported effort.

Before every call use show_dsh_progress when available and pass progress_id. Use a fresh card for each continuation, but pass the existing session_id to keep the DSH conversation. Resumes must retain the same project_root and actual cwd. Never open a sidebar/browser automatically. Do not read cards, read_dsh_progress, raw sessions or hidden reasoning. Logs/view_token stay in UI-only _meta. get_dsh_monitor is only for explicit external-monitor requests.

## Review the result

Inspect status, exit_code, answer, output_source, session_id, assistant_seq and turn. Accept only the latest durable session answer. Empty/unreadable output is a failure; completed means the turn ended, not acceptance. Check the actual files and relevant evidence. Repeat valid checks only when changes, uncertainty or a failure justify it; distinguish DSH's reported commands from checks you ran. Git reports omit ignored files and full internal submodule changes.

Use the returned session_id for related follow-ups and corrections. Allow one unsuccessful corrective continuation before Codex takes over. Inspect partial changes after timeout/cancellation. Report blockers rather than bypassing them. For setup problems use dsh-mcp setup or doctor and consult the README only as needed. A fresh handshake does not reload an existing App connection. Do not restart the user's client or inspect login files automatically.
