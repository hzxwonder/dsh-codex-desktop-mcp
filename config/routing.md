## Codex and DSH collaboration

Codex directly handles instant, reliable answers/edits that need no exploration or whose delegation overhead outweighs the result. Codex also owns creativity, aesthetics, open-ended research, papers/important writing, complex or coupled work, high-risk decisions, final review and publishing.

Use deepseek-worker for bounded, verifiable tasks that benefit from meaningful local investigation, reasoning or implementation choices. Codex defines the result and acceptance; DSH explores within that contract. For mixed tasks, keep product/creative/high-risk decisions in Codex and delegate suitable bounded parts. Batch compatible work. Do not implement a task and then ask DSH to duplicate it.

Honor explicit user worker choices, project restrictions and network limits. The local DSH Harness calls the configured model API with separate fees. Keep the selected Codex model and DSH provider/model; do not substitute a direct API call. If tools or authorization are unavailable, explain and handle permitted work directly.

Each task prompt must state goal, known facts, allowed files, local decisions permitted, acceptance checks and a concise final receipt. DSH must report material missing/conflicting requirements before edits, rather than invent product behavior.

Every call/resume needs the authorized absolute project_root and an explicit thinking_effort allowed by the current schema. Never infer the root from HOME/installation or default the effort. Keep cwd inside the root and serialize workspace writers. File scope is an instruction, not a read ACL. Never send secrets or expand permissions.

Continue related work with the returned session_id, the same project_root and actual cwd. Before each call/resume show_dsh_progress when available; use a fresh progress_id while retaining the DSH session_id. Logs and view_token stay in UI-only _meta. Never automatically open a sidebar/browser or read cards, read_dsh_progress, raw sessions or hidden reasoning. get_dsh_monitor is only for an explicit external-monitor request.

Review the latest durable answer (output_source: session), actual files and focused acceptance evidence. completed is not acceptance. Reuse valid checks and avoid duplicating full file contents. Allow one corrective continuation, then Codex takes over. Report blockers/partial work. dsh-mcp doctor checks a fresh connection, not the running App connection.
