---
name: pdf-html-converter
description: Convert, re-convert, proofread, or quality-check scanned MEW PDF page groups into publication HTML in the Codex desktop GUI or VS Code/IDE extension. Always orchestrates one native pdf_page_worker subagent per accepted page group inside the current signed-in app session; does not launch Codex CLI processes or use third-party model APIs.
---

# PDF to HTML conversion

Use this skill only in the current GUI/IDE session. For unattended `codex exec` batches, use the separate `$pdf-html-converter-cli` skill.

## Resolve the workspace

Resolve the directory containing `MEWbrief.py`, `unpackpdf.py`, `prompts/`, the source PDFs, and `MEW_BRIEF/` in this order:

1. A workspace path explicitly supplied by the user.
2. `MEW_PDF_WORKSPACE`.
3. The current directory or one of its parents.
4. The skill script's directory or one of its parents.

Pass the resolved path with `--workspace`. The helper accepts relative PDF, cache, and output overrides relative to that workspace, but its JSON output always contains absolute paths. The skill can therefore be installed in any local directory without relying on its own location as the document root.

## Orchestrate every page group

1. Generate the page-group plan:

   ```powershell
   python "<skill-dir>/scripts/codex_pdf_convert.py" plan --workspace "<workspace>" --vol 37 --pages 3-12
   ```

2. If the request cuts through a known `MEWbrief.page_group`, report the partial groups and obtain user confirmation before adding `--allow-partial`. Never silently expand or omit pages.
3. Generate one machine-readable job per accepted group. This renders the required images and supplies absolute paths:

   ```powershell
   python "<skill-dir>/scripts/codex_pdf_convert.py" manifest --workspace "<workspace>" --vol 37 --pages 3-12
   ```

4. For every job in `jobs`, including when there is only one, immediately call one `pdf_page_worker` subagent. Keep at most 20 workers active at once. Do not convert a group in the parent thread.
5. Send the worker the job object verbatim plus `volume`, the absolute `requirements` path, the optional absolute `notice` path, and any user instruction. Explicitly require two passes: first convert and save, then reopen the saved HTML and proofread it against every supplied image before returning.
6. Give each worker exactly one unique output path. Never overwrite an existing result unless the user explicitly requested reconversion; in that case rerun `manifest` with `--force` and preserve `force: true` in the worker request.
7. Wait for active workers before starting the next pair. The parent checks that each returned path exists and that the HTML has a title, a complete body, valid note IDs/backlinks, appropriate headings, and no Markdown fences.
8. If validation fails or the worker reports uncertain text, send a focused correction request to that same worker. The parent may inspect only the ambiguous images when necessary. Summarize completed, skipped, corrected, and failed groups.

Use this worker request shape:

```text
Convert and proofread exactly one MEW page group.
volume: <volume>
pages: <ordered physical pages>
images: <ordered absolute PNG paths>
requirements: <absolute prompt-file path>
notice: <absolute NOTICE path or null>
output: <absolute HTML path>
force: <true|false>
user_instruction: <text or none>

Open every image and read the complete requirements file. Convert and save the HTML, then reopen it and perform a second proofreading pass against all images. Correct transcription, cross-page joins, headings, typography, and note links before reporting success. Do not spawn another agent or invoke Codex CLI.
```

Volumes 23-25 automatically use `prompts/convert23.md`; all other volumes use `prompts/convert2.md`. Physical PDF page numbers are the user-facing page numbers. For path, model, or migration diagnostics, read `references/migration.md`.
