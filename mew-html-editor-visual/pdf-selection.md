`public/reader.html` loads the review provider and selection attachment from `public/pdfdiff/` through the normal static asset route:

```html
<script src="/pdfdiff/pdf-review-provider.js"></script>
<script src="/pdfdiff/pdf-selection.js"></script>
```

The complete HTTP backend is `reader-server.py`, migrated from `reader-server.js`.
The JavaScript entry point forwards the existing CLI to Python for compatibility.
Start it directly with `python reader-server.py -c path/to/.mew-reader.json -p 17000`.
Install extraction support with `python -m pip install PyMuPDF`.

`pdf_text_backend.py`, beside `reader-server.py`, extracts the embedded text layer
without running an OCR model. Its page JSON follows the text-result fields of the
[PaddleOCR-VL-1.6 unified interface](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PaddleOCR-VL.en.md).
The local cache schema is 7 (independent of the model version). Each volume has:

```
OCR_DATA/<pdf-stem>.<path-hash>/
  manifest.json
  page-00001.json
  page-00002.json
  ...
```

The manifest stores PDF identity, `interface: "PaddleOCR-VL-1.6"`,
`source: "embedded_pdf_text"`, `geometry: "pdfjs"`, the shared font table and page
file indexes with global code-point boundaries. Each page uses `input_path`,
zero-based `page_index`, `page_count`, and `parsing_res_list`. Each block preserves
`block_id`, `block_order`, `block_label`, `block_content`, and `block_bbox: null`.
PDF text blocks are labelled `text`; semantic title/table predictions are not
invented. No model confidence, preprocessing results or images are fabricated.
Geometry is intentionally unresolved until PDF.js renders the page.

Finer-grained extensions preserve block and line `start`/`end` offsets relative
to the page, and each line's ordered `spans`. A span stores `length` (Unicode code
points) and `font_index`. Starting at the line's `start`, cumulative lengths
recover each span's exact character boundaries; the line ends with one newline.
Each page also includes a backend-prepared `comparison` object with `raw` text,
global UTF-16 `start`/`end`, and ready-to-use `parts` with `fontIndex`. The original
page/block/line/span fields and their code-point offsets stay unchanged. Text is
repeated once in `comparison.raw` so the frontend can use it directly; there are
no text copies in lines/spans or the manifest. There are no character boxes, transforms or per-character style arrays.
Font metadata retains the exact embedded name, size, flags, bold/italic state,
color, alpha, ascender and descender. Unreliable OCR style remains unknown.

The complete volume is staged before replacement; all page files plus the
manifest must total at most 5,000,000 bytes. A size error leaves existing files
untouched. Schema and PDF modification time/size invalidate old data. Individual
files are replaced atomically and the manifest is published last. Page results
carry a document identifier to reject mixed PDF generations. Superseded monolithic
`.ocr.json`, `.ocr.browser.json` and `.ocr.json.gz` caches are no longer used.

Pre-extract with `python pdf_text_backend.py -c CONFIG`; `--cache-dir DIRECTORY`
overrides the output location. Reader startup prepares local volumes before
listening. `pdfTextUrl` points to `/OCR_DATA/<volume-directory>/manifest.json`.
The backend serves only configured manifest/page paths, sending the saved bytes
without JSON parsing or PDF extraction. Files contain indented UTF-8 JSON without
gzip compression. `pdf-selection-diff.js` fetches pages with concurrency limited
to four and consumes the prepared comparison text and UTF-16 runs directly,
attaching shared font metadata without rebuilding character offsets.
`local-ocr-text-reader.js` is used only for embedded PDF text/font fallback when
the generated JSON is unavailable or invalid. Existing
source/PDF.js text-layer diff mappings supply DOM spans, selection/highlight
geometry, popup anchors and precise scrolling. Unloaded targets first navigate
to their page, then use its live text layer. Remote PDFs retain the PDF.js fallback.

The Python HTML review shares this page cache. Only crop/context requests read
native character geometry from the requested PDF pages; extracted text must match
the stored sequence. This geometry is never persisted. Original PDFs and scans
remain unchanged. Restart the reader and reload the page after changing schemas.

`pdf-review-provider.js` is the runtime entry. It owns normalization, source/PDF
indexes, page scopes, contextual search, cached bidirectional connections, review
candidate generation, provider actions and highlights. It loads
`pdf-selection-diff.js` for font reading, text comparison and edit helpers,
`replacement-review.js` for reusable highlight/selection tools and the shared
popup, session, navigation and saving.
Each script keeps its implementation in a private closure. The font/text script
receives prepared connection comparisons for format differences and never calls
back into the provider. The provider reuses each connection's cached text diff.
Text comparisons use Monaco with the local fallback inside `pdf-selection-diff.js`.
`PdfReviewReady` resolves after review initialization;
`pdf-selection.js` waits for it and obtains its locator through the provider.
Its `PdfReviewProvider.createLocator(options, environment)` API creates a locator
with reader-local caches. Selection exposes this locator as `PdfSelection.locator`;
review, including the split editor window, consumes the same locator. Each Monaco
model/PDF pair owns one current source snapshot. The environment supplies the current PDF, rendered page
indexes, idle scheduling, and cancellation checks. Selection keeps `findLocations()`,
`locateSource()`, and `locateLayer()` as private functions using that shared locator.
`findLocations()` returns PDF
page targets, `locateSource()` returns a source hit and any difference notice, and
`locateLayer()` returns character ranges for the rendered text layer.
`pdf-selection.js` captures selections, supplies that environment, and uses its
results to scroll and publish selection mappings. `pdf-review-provider.js` supplies
PDF ranges and source decorations to its own `ReviewHighlights` instance.
`replacement-review.js` owns DOM range measurement, merged highlight rectangles,
overlay painting/cleanup, Monaco decoration caches and marker selection through
`ReviewHighlights`, alongside the shared popup. Highlight instances remain
independent and have no PDF or review-provider dependency.

The provider supplies PDF content and actions to the shared popup host, documented in [replacement-review.md](replacement-review.md).
The “审阅 / 批量替换” submenu has separate switches for PDF review and bidirectional
selection highlighting. The review popup selects a source field; this script reacts
through its ordinary selection listener and never opens or manages that popup.
`PdfSelection.enabled` reports difference highlighting; `selectionEnabled` reports selection synchronization.

Selection events carry rendered index/range metadata. The provider resolves those
ranges against the saved OCR sequence before producing text or format notices.
`pdf_text_backend.py` owns PDF text extraction, font metadata, persistent caches,
and canonical format runs. `local-ocr-text-reader.js` loads that saved data and
owns all frontend PDF font reading, including text-layer font lookup, operator
inspection, shared font tasks, and PDF.js fallback when the cache is unavailable.
`pdf-selection-diff.js` delegates font reading to it and retains source/page
scope selection, format-run comparison, and edits.
The browser owns HTML bold/italic interpretation,
format comparison and source format edits. `differences()` classifies text changes
and unchanged font runs in one traversal per connection; candidates and decorations
reuse that result until the source or connection diff changes. `indexFonts()` uses
the same saved document index without additional PDF reads; only a text-layer
fallback delegates font extraction to the OCR reader.
Font differences are emitted only for unchanged aligned characters.
Failed text requests can retry; document mappings
and cancellation remain local to each locator. Monaco loading also shares one
pending request. Source edits invalidate all mappings for the pair, including
markup-only edits. Selection, decorations and review prepare mappings from the new
snapshot. Manual edits and replacements rediscover review candidates instead of
only shifting the previous list; unchanged candidates keep their selected choices. Shared text significance and changed-range rules live
in `pdf-selection-diff.js`; settings persistence and DOM measurement live in
`pdf-review-provider.js`; popup session state lives in `replacement-review.js`.
Rendered layer indexes use a 24-page LRU; evicted layer observers are disconnected.
Each retained page keeps at most 32 geometry results. Per-target transient selection
mappings keep at most 128 entries, while required prepared passage mappings remain
available. Page preparation ignores LRU ordering and prunes contained mappings with
a sorted sweep instead of comparing every pair.
The “PDF 斜体／粗体探测” menu entry lists styled PDF runs that can be mapped to the
current HTML, with source navigation. This is inspection only; it does not change
HTML markup automatically. Font metadata loads with OCR page reads without rendering or
modifying the PDF. An OCR font describes the hidden text layer, not the scan's
visible letter shapes.
Retained OCR font declarations participate in comparisons even for invisible text
(rendering modes 3 and 7), non-embedded fonts, or fonts shared with visible text.
The popup identifies these as OCR declarations, without claiming scan verification.
This reads font styles retained in PDFs such as ABBYY exports, not an OCR SDK or
external XML/hOCR file. Tesseract's `GlyphLessFont` (including subset names) is a
placeholder and reports both attributes as unknown, never as regular text.
Style declarations are checked per page. Uniform italic declarations become unknown. When at least 80% of the page's
non-whitespace characters claim bold, those bold declarations become unknown and
no scan-based fallback runs during review or selection loading. Unknown styles
do not establish a mismatch. These scripts neither render nor modify scan images.
PDF.js Find may split each text div into several nested nodes; selection mapping
keeps the original div's font and measures the individual text nodes. Text-layer
mutations repaint active highlights, and zoom/rotation discard old overlays.

Remove the three tags and reload the reader to disable the whole feature, including
split-window selection capture. The separate editor also loads the shared toolbox and review provider.
The reader owns and disposes its editor subscriptions on reload or close.

PDF text highlighting uses the displayed text layer together with the shared
Python OCR cache. Pages without a text layer receive no highlights. Extraction
requires PyMuPDF; it reads embedded OCR and never runs a new OCR recognition pass.

For another page served by the reader server, load it manually in the browser
DevTools console:

```javascript
(async () => {
  for (const src of ["/pdfdiff/pdf-review-provider.js", "/pdfdiff/pdf-selection.js"]) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src; script.onload = resolve; script.onerror = reject;
      document.head.append(script);
    });
  }
})();
```

Select any part of a word or phrase in Monaco or the visual editor. The script captures up to
160 characters of surrounding text on each side and searches the text of all PDF
pages, including pages outside the viewport. If the selection and context identify
a unique location, the PDF scrolls to that occurrence and highlights it. The rendered
text layer supplies the selected text's position. If that position is already in
the PDF viewport, the script leaves the scroll position unchanged. Scrolling happens
once per selection and PDF document, so subsequent manual scrolling remains possible.
Scrolling reuses cached page coordinates and existing highlights; text-layer rendering,
zoom, and rotation invalidate the relevant cache.
Wheel, touch, scrollbar interaction, and PDF navigation keys cancel pending automatic
positioning, including a delayed match or text layer. A new source selection can
position the PDF again. These listeners are passive and never consume scrolling.
Routine viewport events do not prepare mappings or reload the source. Render events
share one idle preparation queue, and provisional and confirmed matches use the same
painting path. Full-PDF normalization yields between complete-line chunks and pauses
briefly during PDF or editor interaction. Cache keys contain matching text and notices,
so scrolling never serializes the entire source index.
Each text layer keeps up to 32 coordinate results for the current source index. Repeated
selections reuse those ranges and update existing overlay rectangles. Source versions
and rebuilt text layers invalidate the cache. Pending comparison popups belong to their
paint result, so an older popup cannot return after the overlay has been reused.
Each cached result also retains its original-text popup diff, so returning to the same
selection does not compare the readings again. Alignment creation reuses an existing
connection for the same source and target intervals, and whole-text alignments reuse
the indexes' normalization maps. Partial ranges normalize independently to preserve
selection boundaries around line hyphens and Unicode characters.

Selection also works from PDF to Monaco, in the combined reader or its paired
editor window. Select text in the PDF's text layer to select and reveal the
corresponding HTML source in Monaco. Tags and decoded entities retain their
original source offsets, including selections spanning inline formatting or PDF
pages. The same contextual matching handles repeated phrases and small OCR
differences; an ambiguous or missing match leaves Monaco's selection unchanged.
PDF selections also show the comparison popup when the readings differ.
When a selected passage differs, the whole passage stays selected and highlighted.
The popup shows the complete HTML and PDF readings with every mismatch marked,
including differences far apart in the selection. Replace applies the selected
passage's text corrections together as one undoable edit, retaining HTML markup.
With Monaco attached, the popup stays inside the source pane (including its
separate window), so it does not cover the scanned words. The "Replace with PDF
text" button applies the embedded PDF text to the mapped source range as one
undoable edit, retaining HTML tags and escaping replacement text. It also handles
missing characters and surplus HTML characters. A changed or read-only model
cannot be replaced through a stale popup. Clicking a source difference compares
literal readings even when location matching normalizes them, such as curly and
straight quotation marks.
An ambiguous or missing match shows "No reliable HTML match" over the selected PDF text.
Clearing the native PDF selection removes the popup.
Only the currently loaded Monaco document is searched. Focus stays in the PDF,
so you can continue selecting or copying its text. Source content is never edited,
and programmatic Monaco selections do not trigger a reverse-sync loop.

For one HTML file containing several PDF pages, reverse selection first locates
the selected page's text within the HTML and searches that section. This resolves
passages with identical nearby wording on different pages. If a running header or
OCR difference prevents a whole-page match, unique fragments in page order can
identify the section. Uncertain page locations retain the contextual search;
ambiguous selections still leave Monaco unchanged. Source and page-section indexes
are cached and refreshed when the HTML or rendered PDF text changes.
Prepared mappings sample overlapping 32-character anchors every 16 characters,
then validate the passages between them with bounded diffs. This lets selections
after nearby OCR errors reuse the same character mapping in either direction.

Selections use this fallback order:

1. Project through a prepared character diff.
2. Search for a unique location using the selection and its surrounding context.
3. Highlight all selected words on visible pages, applying word replacements learned
   from confirmed diffs (for example, `Wage` → `lVage`, `Strebern` → `5/refiern`).

The last fallback may highlight multiple occurrences and does not establish a source
location for reverse selection. Conflicting learned replacements are ignored. The
patches exist only in the current source/PDF mapping; neither document is changed.
Multiple selections are supported and fall back individually. Matching ignores case, normalizes
ligatures and quotation marks, and joins words hyphenated across line breaks.
HTML tags in source selections are removed and entities decoded before matching.
Both directions use the same full-document text index, cached by Monaco model
version. Unsaved content changes clear stale highlights and wait for a 350 ms typing
pause before reading the latest source and selection. Cursor events during that
pause share the same timer; background mapping and decoration refreshes also wait
for this pause. HTML-only text uses a solid 2 px caret between the corresponding
PDF characters, including when the PDF text is split across rendered spans.
Failed page preparation is also cached for that source
and PDF text-layer pair, so unmatched revised text does not repeatedly rebuild maps.
Selections inside a wrapper and selections spanning inline tags map to
the visible characters through their original source offsets. Selection boundaries
inside attributes or entities are resolved using that index rather than parsing
incomplete HTML fragments. Attributes, comments, and head/script/style content
do not participate in matching; markup-only and collapsed selections clear the
highlights. Visual-editor text is already decoded and is not parsed as markup.
The character diff compares plain text, so formatting changes do not count as
OCR differences. Source tags remain intact, and reverse selections spanning
formatting include the intervening tags in Monaco's contiguous source range.
Substring matching is enabled by default, including selections within continuous
Chinese text. Only the matching characters are highlighted, using the original
PDF text offsets. Set `wholeWords`
to `true` only when you explicitly want word-boundary filtering.

When an exact contextual match fails, a small character diff can locate a near
match with insertions, deletions, or substitutions on either side. For example,
selecting HTML `schöpliche` can highlight PDF `schöpfliche`, and vice versa.
The nearby "Text differs" popup shows both readings with changed characters
marked. It does not decide which reading is correct or modify either document.
Tolerance requires matching surrounding text and a unique location. It allows
up to 20% changed characters (at least one, at most three), for selections of
3–128 characters, and rejects ambiguous or substantially different passages.
Longer selections of up to 2,048 UTF-16 units can align small internal OCR or
note-marker differences when matching context identifies both boundaries.
Each boundary requires at least 12 normalized context characters. These ranges
allow up to 5% changed characters (at least three, at most 32); repeated boundary
pairs and substantially different passages are rejected. This also works across
inline tags and empty anchors in continuous German or Chinese text, without
inserting spaces around the tags.
After interaction pauses for 100 ms, the existing page-scope search prepares
bidirectional character alignments from each rendered PDF page into the HTML.
It reuses the source index and avoids a full-document startup diff. Unique ordered
32-character anchors are sampled every 64 normalized characters; the intervening
passages are aligned only when their bounded diff remains within 8% changed
characters (at least 12, at most 32). These preparation limits apply between unique
ordered anchors, separately from selection-time fuzzy matching. Consecutive validated
passages share an alignment; a failed gap, such as reordered table columns, separates
the groups without discarding the valid text on either side. Page-scope searches
without diff preparation retain longer 96-character anchors to distinguish repeated
passages. Longer selections can cross OCR differences inside each validated group.
Exact page matches also prepare an alignment for arbitrary selection lengths. Uncertain or substantially different
passages retain normal contextual search. Smaller selections reuse these maps
instead of requiring a damaged OCR word to match independently.
For example, the first HTML `Strebern` selection can select PDF OCR
`5/refiern`, and selecting that OCR text can select `Strebern` inside its original
HTML formatting. The connection covers normalized text and projects back through
the original HTML and PDF offsets, including entities and line hyphenation.
A changed run maps to its whole counterpart when individual character positions
are uncertain; a pure deletion has no counterpart to highlight. Connections are
cached for the Monaco model version and PDF text index. The cache bound scales
with source length. Source edits rebuild HTML offsets and all pair mappings.
Unchanged model versions reuse their snapshot; switching PDFs selects a separate
pair, and rebuilt text layers get new mappings. Visible
text layers can prepare their maps while document extraction is still running.
A selection covered by a visible-page diff highlights immediately without awaiting
the full-document index. Provisional visible-page matches also use diff, context,
then patched-word fallback while extraction continues.
Initial preparation needs available text indexes; it is not instantaneous while
the PDF or HTML is loading. The script saves no corrections to either document.
Exact matches and partial-word selections keep their existing behavior.
The separate `public/pdfdiff/pdf-selection-diff.js` script first loads the installed Monaco
character diff computer from `/monaco/esm/`. Its character ranges supply selection
positions. Confirmed passages also use Monaco's native decorations collection for
source-line margin markers and exact character highlights, with HTML/OCR hover readings.
Tags are excluded, entities keep their original source ranges, and text missing from
HTML receives an insertion marker.
Click a character highlight, insertion marker, or source-line margin marker to show
the corresponding PDF difference and its comparison popup. Whitespace-only and
hyphen-only changes are filtered from source decorations.
Prepared document alignment covers matching passages
outside the visible PDF pages once extraction completes; uncertain passages stay unmarked.
Edits, document switches, PDF replacement, and stopping the script clear stale decorations.
If Monaco cannot load, times out, throws, or returns incomplete ranges, difference
decorations and changed-word emphasis in comparison popups are disabled. The local
engine can still supply selection mapping. Bounded local edit distance
continues to determine OCR acceptance; Monaco diff grouping does not change that
threshold. The local fallback trims shared prefixes and suffixes.
A Levenshtein wavefront skips equal character runs and tracks only reachable edit
diagonals. Distance checks stop at their tolerance and retain the current frontier;
detailed comparisons retain compact traceback for reconstructing both complete
readings, stopping at 128 edits. Larger differences do not create a local character
mapping. Popup emphasis and editor decorations require a successful Monaco comparison.
This preserves character insertion, deletion, substitution, and Unicode
handling without allocating a matrix proportional to both file lengths.
Highlight geometry uses one DOM Range across the selected OCR spans and combines
adjoining rectangles on the same line. All comparison popups are populated on
the next task after the highlight, so their text and layout do not delay highlighting.
Clearing or replacing a selection discards its pending popup.

The script captures the private PDF.js viewer through its runtime events, even
when injected after the PDF has loaded. It searches the rendered text layer on
visible pages for highlight coordinates and retries as text layers render. The
document text index is cached per PDF. Scanning yields between pages and waits
while PDF or editor interaction continues. Each scanned page extends the normalized
text and UTF-16 offset mappings, retaining hyphenated page continuations, without
a second whole-document normalization pass. Visible text-layer node mappings
are prepared when pages render and reused across selections. Selections run immediately,
without the former 160 ms debounce. Binary search visits only the spans intersecting
a match; the existing OCR spans are never split or rewritten.
Visible-page highlights appear while that search runs and remain available if
page-text extraction fails or the rendered spans cannot confirm the exact location.
The PDF file is never modified.
The PDF reading comes from its embedded text layer and may itself contain OCR errors.

Full-volume extraction builds text locally for each page before appending it to the
document index, retaining global item offsets and cross-page hyphenation. Preparation
uses a shared index of aligned 16-character blocks to verify unique 32-character
anchors without rescanning the entire volume for every anchor. Reordered footnotes
separate independently validated passages instead of discarding all mappings.
Merged passages keep a conservative edit budget so a long multi-page file does not
lose its mappings at the whole-range traceback limit. Reverse mappings reuse the
forward diff and rebuild word replacements in the source-to-PDF direction.

Manual console injection lasts until the page reloads. For other applications
that do not include the reader tag, you can install the same JS file in a
userscript manager using its included header, with execution in the page's
JavaScript context.

Set browser options **before** injecting the script:

```javascript
window.PdfSelectionOptions = {
  viewerModuleUrl: "/vendor/pdfjs/web/pdf_viewer.mjs",
  wholeWords: false,
  color: "rgba(255, 196, 0, 0.42)"
};
```

For another application, pass its existing Monaco editor and PDF.js viewer:

```javascript
PdfSelection.attachEditor(existingMonacoEditor);
PdfSelection.attachViewer(existingPdfViewer);
```

Useful console calls:

```javascript
PdfSelection.highlight("selected phrase");
PdfSelection.highlight(["first phrase", "second phrase"]);
PdfSelection.status; // State, pages, match count, mode, differences, errors.
PdfSelection.clear();
PdfSelection.stop(); // Removes listeners, highlights, and restores its runtime hook.
```

In the reader's split-window mode, the script captures the existing named editor
window (`mew-editor-<session>`) and subscribes directly to its Monaco selection
events. Both windows must have the same origin, as in the existing split workflow.
After the reader reloads into split mode it reacquires the paired editor.
No editor JavaScript or editor HTML is modified. Highlights follow
PDF scrolling, page changes, zoom, rotation, and document switches. Pages outside
the PDF viewport receive fallback highlights when they become visible.

The caching and offset-mapping approach follows PDF.js's
[find controller](https://github.com/mozilla/pdf.js/blob/master/web/pdf_find_controller.js)
and [text highlighter](https://github.com/mozilla/pdf.js/blob/master/web/text_highlighter.js).
Overlay ranges preserve the original OCR DOM and native PDF text selection.

Run `node --test tests/pdf-selection-highlight.test.mjs` for correctness and timing
checks. An independent edit-distance oracle checks Unicode traceback and bounded
distance across 250 generated input pairs. The browser selection benchmark measures
callback to completed highlight layout across 100 selections for each of identical
and OCR-damaged text, using a synthetic 100-page PDF and 1,500 rendered OCR spans.
Selections range from a single character to a whole 15 KB file. Each measured selection must
finish below 10 ms after preparation without new text-node walks or source reads.
The separate 15,000-byte Latin and mixed Unicode diff benchmarks reconstruct both
complete readings with 47–87 scattered substitutions, insertions, and deletions and require each of 12 diffs
to complete below 50 ms, including the first call.

These checks measure application processing and layout on the test machine, not
physical display presentation or every possible file. Cold PDF extraction, unloaded
text layers, browser scheduling, hardware, ambiguous text, and substantially different
readings can exceed these targets. High edit distances increase wavefront time and
traceback storage. A separate regression test uses captured ME34-010/ME34-014 HTML
and actual embedded OCR items from `mew_band34.pdf` pages 34, 35, and 38. It measures
100 whole-word and partial-word selections with full-PDF extraction blocked, checks
that no selection rebuilds a diff or text-node index, verifies reverse selection,
and exercises patched-word fallback from an added unmatched paragraph. The OCR spans
use the captured item positions with browser serif fonts; the PDF viewer and canvas
are mocked. This covers the reported text differences, rather than live-reader
performance or physical display presentation. Visible fallback matches remain
available while the document index loads.
`tests/fixtures/pdf-selection-me23.json` captures the actual
`MEW_BRIEF/23/ME23-316.html` and embedded OCR items from PDF pages 318–322.
The diff suite checks both mapping directions across these five pages, global item
offsets, reordered footnotes, and reuse of forward comparisons. A longer generated
passage checks that 300 OCR edits retain mappings in bounded groups.
The native scrolling regression uses browser wheel events on a PDF container and a
text pane, plus keyboard navigation. It checks that late extraction and text-layer
rendering do not override manual scrolling, and that ready-page scrolling performs no
mapping preparation, new diffs, or source reads. The viewer and editor adapters are
mocked; this is not a live Monaco/PDF.js session.
