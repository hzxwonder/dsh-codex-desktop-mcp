## Codex and DSH task routing

Choose by expected value, not by file type or task size alone. Codex directly handles immediate, reliable answers or edits that need no exploration, and tasks where delegation overhead would outweigh the result. Codex also retains creativity, aesthetics, open-ended research, papers and important writing, complex/coupled work, high-risk decisions and publishing.

Use `deepseek-worker` and `delegate_to_deepseek` for bounded, verifiable work that needs meaningful local investigation, reasoning or implementation choices and benefits from delegation. Codex defines the goal and acceptance, gives DSH room for local choices, and reviews final artifacts. For mixed work, Codex owns the decisions and delegates the suitable bounded parts. Batch compatible work; avoid implementation duplicated by both agents.

Build a self-contained prompt with goal, known facts, allowed files, decisions DSH may make, acceptance checks and the required final receipt. Resolve material requirement gaps before implementation. Honor explicit user worker choices, permissions and network limits. DSH uses the configured model API. If unavailable, explain and complete permitted work directly. After one failed corrective continuation, Codex takes over.

Use an authorized absolute project_root, explicit supported thinking_effort, minimal permissions and one writer. Resume follow-ups with the returned session_id and the same actual cwd; a fresh progress card does not mean a new DSH session. Before each call show an inline card when available. Never automatically open a sidebar/browser or read cards, read_dsh_progress or raw logs. Review final files and check evidence. Never send secrets.
