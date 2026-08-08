# Migration map

`useaipdf2.py` kept image review and file editing in one multimodal conversation. The native skill preserves one signed-in Codex session while moving each page group into a visible child thread.

`useaipdf3.py` separated orchestration from per-group conversion. The native branch now uses the main Codex agent as planner and verifier, and always delegates each accepted group to `pdf_page_worker`. Each worker performs conversion plus a second proofreading pass and writes only its assigned HTML file.

The old unattended `codex exec` dispatcher remains available only through the separate `$pdf-html-converter-cli` skill. The GUI/IDE skill must never invoke that branch, so it cannot create a second CLI login or parallel application session.

The project agent is configured in `.codex/agents/pdf-page-worker.toml` with `gpt-5.6-luna` and low reasoning effort. Native subagents use the signed-in parent Codex session and are visible in the desktop/IDE interface. Keep conversion concurrency at 2-8 even though the project permits up to 20 child threads.

The helper locates the content workspace independently of the skill installation directory. Prefer `--workspace`; otherwise it reads `MEW_PDF_WORKSPACE`, then searches from the current directory and script ancestry. Its `manifest` response contains absolute image, prompt, notice, and output paths, so workers never infer paths from their own working directory.

Safety invariants:

- Do not silently expand partial ranges.
- Do not overwrite HTML unless `force: true` reflects explicit user authorization.
- Give each worker exactly one page group and one output path.
- Require the worker to convert, reopen, proofread, and validate before success.
- Never let a worker spawn another agent, invoke `codex exec`, or call an external model API.
