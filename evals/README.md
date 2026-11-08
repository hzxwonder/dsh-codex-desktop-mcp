# Routing evaluation

Use `prioritized-planning.md` as a realistic task after changes to routing rules, worker prompts or concurrency. It specifies scientific and engineering acceptance without naming a worker or prescribing delegation.

1. Save the rule/source hashes and start a fresh isolated Codex chat with the unchanged task. Use the configured Codex and DSH models. Keep the prior chat and artifacts as the baseline.
2. Observe actual delegation calls, task contracts, permissions, project roots, session IDs, corrective continuations and implementation ownership. Record only public task metadata and final receipts. Keep progress payloads and raw DSH logs out of model context.
3. Check actual artifacts. Run independent value/policy checks, the test suite and at least one held-out interface case. For excluded inputs, test noninterference. Preserve resource limits, raw results, negative observations and censored outcomes.
4. For concurrent work, verify distinct sessions and isolated write roots. The batch tool must return both indexed outcomes, including partial failures. A queued or serial call is not concurrency evidence.
5. Compare first-pass acceptance, correction count, Codex repairs, final acceptance, latency and available token usage. One failed corrective continuation ends worker retries for that task; Codex completes the repair. Source ownership and elapsed time do not establish token savings.

The same natural task can produce different valid scientific protocols. Compare their shared acceptance requirements; do not treat different budgets or algorithms as a controlled performance A/B test. Record each protocol before its formal run. Use repeated task families and available account usage measurements before claiming unchanged general capability or lower operating cost.

Keep discovered failures as regression cases. Change one routing hypothesis per iteration when possible. Freeze the acceptance set before the next run. Do not weaken an oracle to accept a worker output, and do not tune rules only to one benchmark.

An evaluation receipt should include:

- Rule/source hashes, unchanged task hash, model identifiers and result paths.
- DSH implementation and review call counts, task scopes and session continuations.
- Actual concurrency evidence and conflict/cancellation checks.
- Independent acceptance, held-out cases, corrective work and remaining limits.
- Measured usage when available, otherwise explicitly labelled proxies.

The local bridge regression suite uses simulated model endpoints for repeatability. Live task evaluations use the configured model API and have separate fees. Keep those two kinds of evidence distinct.
