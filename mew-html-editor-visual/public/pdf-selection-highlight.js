// ==UserScript==
// @name         MEW PDF selection highlight
// @namespace    mew-local
// @version      1.9.0
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
// Standalone reader attachment; configuration and usage: pdf-selection-highlight.md.
(async () => {
  "use strict";
  if (typeof window === "undefined" || window.PdfSelectionHighlight) return;
  await window.PdfSelectionDiff.loadMonaco();
  if (window.PdfSelectionHighlight) return;
  const options = {
    viewerModuleUrl: "/vendor/pdfjs/web/pdf_viewer.mjs",
    color: "rgba(255, 196, 0, 0.42)", wholeWords: false,
    ...window.PdfSelectionHighlightOptions
  };
  const cleanup = [], editors = new WeakSet();
  const editorMarks = new Map();
  const overlays = new Map(), layers = new Map();
  const pageResults = new WeakMap();
  const preparationPages = new Set();
  let preparationTask = null, lastInteraction = 0, lastIndexYield = 0;
  let activeEditor = null, syncingPdf = false, contexts = [], locationSearch = null, scrolled = false, positioned = false;
  let viewer = null, revision = 0, timer, stopped = false, hooking = false, diffHighlight = true;
  let preferenceWrites = Promise.resolve();
  try {
    const response = await fetch('/api/reader/settings');
    if (response.ok) diffHighlight = (await response.json()).diffHighlight !== false;
  } catch {}
  let visualDocument = null, detachVisual = () => {};
  let pairedWindow = null, pairedSession = "";
  const diff = window.PdfSelectionDiff.createLocator(options, {
    document, getPdf: () => viewer?.pdfDocument,
    getTargets: () => [...layers.values()].filter(page => page.pdf === viewer?.pdfDocument),
    getVisiblePages: () => visiblePages().map(number => ({ number, index: layerIndex(viewer.getPageView(number - 1)?.div) })),
    isCurrent: pdf => !stopped && viewer?.pdfDocument === pdf,
    async waitForIdle(pdf) {
      while (!stopped && viewer?.pdfDocument === pdf && performance.now() - lastInteraction < 100)
        await new Promise(resolve => setTimeout(resolve, 25));
      if (performance.now() - lastIndexYield >= 8) {
        await new Promise(resolve => setTimeout(resolve, 0));
        lastIndexYield = performance.now();
      }
    },
    onIndexed: () => { if (editorMarks.size) queueWarm(); }
  });
  const { sourceIndex, editorSourceIndex, normalized, lowerBound } = diff;
  cleanup.push(() => detachVisual());
  const status = { state: "waiting-for-pdf", pages: [], matches: 0, differences: [], error: null };
  const api = window.PdfSelectionHighlight = {
    status, attachEditor, attachViewer,
    highlight: text => select(Array.isArray(text) ? text : [text]),
    clear: () => select([]),
    setDiffHighlight(enabled) {
      diffHighlight = !!enabled;
      const preference = diffHighlight;
      preferenceWrites = preferenceWrites.then(async () => {
        const response = await fetch('/api/reader/settings', { method: 'PUT',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ diffHighlight: preference }) });
        if (!response.ok) throw new Error('无法保存差异高亮设置');
      }).catch(() => window.ReaderUI?.notify('无法保存差异高亮设置', true));
      select([]); updateEditorMarks();
      if (diffButton) {
        diffButton.textContent = diffHighlight ? '关闭差异高亮' : '显示差异高亮';
        diffButton.setAttribute('aria-pressed', String(diffHighlight));
      }
    },
    stop() {
      stopped = true;
      resetPdf();
      clearTimeout(preparationTask);
      cleanup.splice(0).reverse().forEach(dispose => dispose());
      delete window.PdfSelectionHighlight;
    },
    get viewer() { return viewer; }
  };
  function report(state, detail = {}) {
    Object.assign(status, { state }, detail); window.dispatchEvent(new CustomEvent("pdf-selection-highlight-status", { detail: { ...status } }));
  }
  function listen(target, name, callback, options) {
    target.addEventListener(name, callback, options); cleanup.push(() => target.removeEventListener(name, callback, options));
  }
  const popupStyle = document.createElement('style');
  popupStyle.textContent = `
    .mew-pdf-selection-difference{--notice-bg:#fff8df;--notice-ink:#302510;--notice-line:#b87a18;--notice-mark:#ffd098;--notice-button:#fff1c4;position:absolute;z-index:100;pointer-events:auto;box-sizing:border-box;max-height:40vh;overflow:auto;padding:8px 10px;border:1px solid var(--notice-line);border-radius:5px;background:var(--notice-bg);color:var(--notice-ink);box-shadow:0 2px 8px #0003;font:13px/1.5 sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;color-scheme:light;scrollbar-color:var(--notice-line) var(--notice-bg)}
    body.dark .mew-pdf-selection-difference{--notice-bg:#25221c;--notice-ink:#e1d7c4;--notice-line:#97713c;--notice-mark:#634b24;--notice-button:#383025;color-scheme:dark;box-shadow:0 2px 8px #0008}
    .mew-pdf-selection-difference mark{background:var(--notice-mark);color:inherit;font-weight:bold}
    .mew-pdf-selection-difference button{display:block;margin-top:6px;padding:4px 8px;border:1px solid var(--notice-line);border-radius:4px;background:var(--notice-button);color:inherit;font:inherit;cursor:pointer}
    .mew-pdf-selection-difference button:is(:hover,:focus-visible){background:var(--notice-mark);outline-color:var(--notice-line)}
    .mew-pdf-selection-difference .mew-diff-close{float:right;margin:0 0 4px 12px;padding:0 6px;font-size:18px;line-height:1.3}
  `;
  document.head.append(popupStyle); cleanup.push(() => popupStyle.remove());
  const diffButton = document.getElementById('diffHighlightBtn');
  if (diffButton) {
    diffButton.disabled = false;
    diffButton.textContent = diffHighlight ? '关闭差异高亮' : '显示差异高亮';
    diffButton.setAttribute('aria-pressed', String(diffHighlight));
    listen(diffButton, 'click', () => api.setDiffHighlight(!diffHighlight));
  }
  function removeOverlay(painted) { painted?.popups?.forEach(node => node.remove()); painted?.node.remove(); }
  function clearOverlays() { overlays.forEach(removeOverlay); overlays.clear(); }
  function clearLayers() { for (const div of layers.keys()) clearLayer(div); }
  function clearLayer(div) { layers.get(div)?.observer.disconnect(); layers.delete(div); pageResults.delete(div); }
  function resetPdf() {
    ++revision;
    clearTimeout(timer);
    clearOverlays();
    clearLayers();
    editorMarks.forEach(state => { state.collection.clear(); state.source = null; });
  }
  function select(texts, surroundings = [], plain = false) {
    lastInteraction = performance.now();
    const decode = text => (plain ? String(text || "") : sourceIndex(String(text || "")).raw).trim();
    contexts = texts.map((text, i) => {
      const entry = surroundings[i] || {}, value = entry.marked ? text : decode(text);
      const start = entry.start + (plain && !entry.marked ? text.length - text.trimStart().length : 0);
      return { text: value, before: decode(entry.before || "").slice(-160),
        after: decode(entry.after || "").slice(0, 160), index: entry.index, start, end: start + value.length, marked: entry.marked };
    }).filter(entry => entry.text || entry.marked);
    status.differences = [];
    locationSearch = null;
    scrolled = positioned = false;
    if (!contexts.length) {
      clearOverlays();
      report(viewer ? "idle" : "waiting-for-pdf", { pages: [], matches: 0, mode: null, differences: [], error: null });
    }
    schedule(-1);
    return api;
  }
  function schedule(delay = 0) {
    if (stopped) return;
    ++revision;
    clearTimeout(timer);
    const run = revision;
    const execute = () => refresh(run).catch(error => {
      if (stopped || run !== revision) return;
      report("error", { error: error.message });
      console.error("[PDF selection highlight]", error);
    });
    if (delay === -1) execute();
    else timer = setTimeout(execute, typeof delay === "number" ? delay : 0);
  }
  function attachEditor(editor) {
    editor = editor?.editor || editor;
    if (!editor?.onDidChangeCursorSelection || editors.has(editor)) return;
    editors.add(editor);
    activeEditor = editor;
    const node = editor.getDomNode?.();
    if (editor.createDecorationsCollection) {
      const collection = editor.createDecorationsCollection();
      editorMarks.set(editor, { collection });
      const style = (node?.ownerDocument || document).createElement('style');
      style.textContent = '.mew-ocr-diff-line{border-left:3px solid #d58b24;margin-left:3px;cursor:pointer}.mew-ocr-diff-text{background:rgba(255,166,40,.3);border-bottom:1px solid #d58b24;cursor:pointer}.mew-ocr-diff-insert{border-left:2px solid #d58b24;margin-left:-1px;cursor:pointer}';
      (node?.ownerDocument || document).head.append(style);
      cleanup.push(() => { collection.clear(); editorMarks.delete(editor); style.remove(); });
    }
    if (node) {
      const interact = () => { lastInteraction = performance.now(); };
      for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) listen(node, name, interact, { passive: true });
    }
    let readTimer = null;
    cleanup.push(() => clearTimeout(readTimer));
    const read = event => {
      if (syncingPdf) return;
      if (event?.changes || editorMarks.get(editor)?.model !== editor.getModel()) {
        const state = editorMarks.get(editor);
        if (state) { state.collection.clear(); state.source = null; }
      }
      if (event?.changes || readTimer !== null) {
        select([]); clearTimeout(readTimer);
        readTimer = setTimeout(() => { readTimer = null; read(); }, 100);
        return;
      }
      activeEditor = editor;
      const model = editor.getModel();
      let marked = false;
      const ranges = model ? (editor.getSelections() || []).map(range => {
        const position = event?.position || range.getStartPosition(), collection = editorMarks.get(editor)?.collection;
        if (event?.position || range.isEmpty?.()) for (let i = 0; i < (collection?.length || 0); i++) {
          const mark = collection.getRange(i);
          if (mark?.containsPosition(position) || event?.lineMark && mark?.startLineNumber === position.lineNumber) {
            marked = true; return mark;
          }
        }
        return range;
      }) : [];
      if (!marked && !ranges.some(range => model.getOffsetAt(range.getEndPosition()) > model.getOffsetAt(range.getStartPosition()))) { select([]); if (viewer) queueWarm(); return; }
      const index = editorSourceIndex(model);
      if (viewer && index.preparedPdf !== viewer.pdfDocument) queueWarm();
      const entries = ranges.map(range => {
        const start = model.getOffsetAt(range.getStartPosition()), end = model.getOffsetAt(range.getEndPosition());
        const a = lowerBound(index.ends, start + 1), b = lowerBound(index.starts, end);
        return { index, marked, start: a, text: end > start ? index.raw.slice(a, b) : "",
          before: index.raw.slice(Math.max(0, a - 160), a), after: index.raw.slice(b, b + 160) };
      });
      select(entries.map(entry => entry.text), entries, true);
    };
    for (const name of ["onDidChangeCursorSelection", "onDidChangeModel", "onDidChangeModelContent"]) {
      const subscription = editor[name]?.(read);
      if (subscription) cleanup.push(() => subscription.dispose());
    }
    const click = editor.onMouseDown?.(event => {
      if (event.target?.position) read({ position: event.target.position, lineMark: event.target.type === 4 });
    });
    if (click) cleanup.push(() => click.dispose());
    if (viewer) queueWarm();
    if (editor.hasTextFocus() || editor.getDomNode()?.ownerDocument !== document) read();
  }
  function attachVisual(doc) {
    if (!doc || doc === visualDocument) return;
    detachVisual(); visualDocument = doc;
    const read = () => {
      const range = doc.getSelection();
      if (range?.anchorNode && doc.body?.contains(range.anchorNode) && range.rangeCount) {
        const selected = range.getRangeAt(0), before = doc.createRange(), after = doc.createRange();
        before.selectNodeContents(doc.body); before.setEnd(selected.startContainer, selected.startOffset);
        after.selectNodeContents(doc.body); after.setStart(selected.endContainer, selected.endOffset);
        select([range.toString()], [{ before: before.toString(), after: after.toString() }], true);
      }
    };
    doc.addEventListener("selectionchange", read);
    detachVisual = () => doc.removeEventListener("selectionchange", read);
  }
  function attachViewer(instance) {
    if (!instance?.getPageView || !instance.eventBus || viewer === instance) return;
    resetPdf();
    viewer = instance;
    const manualScroll = () => {
      if (viewer !== instance) return;
      lastInteraction = performance.now();
      scrolled = positioned = true;
    };
    for (const name of ["wheel", "touchstart", "pointerdown"]) listen(instance.container, name, manualScroll, { passive: true });
    listen(instance.container, "keydown", event => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) manualScroll();
    });
    for (const event of ["pagesinit", "pagechanging", "pagerendered", "textlayerrendered", "scalechanging", "rotationchanging", "updateviewarea"]) {
      const update = data => {
        if (viewer !== instance) return;
        if (event === "textlayerrendered") clearLayer(instance.getPageView(data?.pageNumber - 1)?.div);
        if (["pagesinit", "scalechanging", "rotationchanging"].includes(event)) clearLayers();
        if (event !== "updateviewarea" && event !== "pagechanging") queueWarm(data?.pageNumber);
        if (contexts.length) schedule();
      };
      instance.eventBus.on(event, update);
      cleanup.push(() => instance.eventBus.off(event, update));
    }
    instance.eventBus.on("pagesdestroy", resetPdf);
    cleanup.push(() => instance.eventBus.off("pagesdestroy", resetPdf));
    report("idle");
    queueWarm();
    schedule();
  }
  function queueWarm(number) {
    if (stopped) return;
    preparationPages.add(number);
    if (preparationTask !== null) return;
    preparationTask = setTimeout(() => {
      preparationTask = null;
      if (stopped) return;
      if (performance.now() - lastInteraction < 100) { queueWarm(number); return; }
      const numbers = [...preparationPages].filter(number => number !== undefined);
      if (preparationPages.has(undefined)) numbers.push(...visiblePages());
      preparationPages.clear();
      warm([...new Set(numbers)]);
      if (contexts.length) { locationSearch = null; schedule(); }
    }, 100);
  }
  function warm(numbers = visiblePages()) {
    const pdf = viewer?.pdfDocument, model = activeEditor?.getModel(), source = model && editorSourceIndex(model);
    if (pdf && !diff.getDocumentIndex(pdf)) void diff.indexDocument(pdf).catch(() => {});
    for (const div of layers.keys()) if (!div.isConnected) clearLayer(div);
    const pages = numbers.map(number => layerIndex(viewer.getPageView(number - 1)?.div));
    diff.prepareSource(source, pages, pdf);
    updateEditorMarks();
  }
  function updateEditorMarks() {
    const pdf = viewer?.pdfDocument;
    const targets = [...layers.values()].filter(page => page.pdf === pdf);
    const full = diff.getDocumentIndex(pdf);
    if (full) targets.push(full);
    for (const [editor, state] of editorMarks) {
      if (!diffHighlight || !window.PdfSelectionDiff.monacoAvailable) { state.collection.clear(); state.source = null; continue; }
      const model = editor.getModel(), source = model && editorSourceIndex(model);
      const connections = source && pdf ? targets.flatMap(target => (source.connections.get(target) || []).map(item => [item, target])) : [];
      if (source === state.source && connections.length === state.connections?.length
        && connections.every(([item, target], i) => item === state.connections[i][0] && target === state.connections[i][1])) continue;
      state.collection.set(source ? window.PdfSelectionDiff.sourceDecorations(source, connections, model) : []);
      Object.assign(state, { source, model, connections });
    }
  }
  async function discoverPdf() {
    if (hooking || stopped || !window.pdfjsLib) return;
    hooking = true;
    try {
      const { PDFViewer, EventBus } = await import(new URL(options.viewerModuleUrl, document.baseURI).href);
      if (stopped) return;
      const originalDispatch = EventBus.prototype.dispatch;
      function dispatch(name, data) {
        if (data?.source instanceof PDFViewer) attachViewer(data.source);
        return originalDispatch.call(this, name, data);
      }
      EventBus.prototype.dispatch = dispatch;
      cleanup.push(() => { if (EventBus.prototype.dispatch === dispatch) EventBus.prototype.dispatch = originalDispatch; });
      if (window.PDFViewerApplication?.pdfViewer) attachViewer(window.PDFViewerApplication.pdfViewer);
      document.querySelectorAll("#stage,.pdfViewer").forEach(node => node.dispatchEvent(new Event("scroll")));
    } catch (error) {
      hooking = false;
      report("error", { error: `Cannot attach PDF.js: ${error.message}` });
    }
  }
  function discover() {
    attachEditor(window.readerMonaco?.editor);
    attachEditor(window.mewWorkbench?.editor);
    window.monaco?.editor?.getEditors?.().forEach(attachEditor);
    const frame = document.getElementById("visualEditor");
    try { attachVisual(frame?.contentDocument); } catch { /* cross-origin frame */ }
    const params = new URLSearchParams(location.search), session = params.get("sync") || "";
    if (params.get("view") === "reader" && /^[\w-]{1,128}$/.test(session) && session !== pairedSession) {
      pairedSession = session;
      pairedWindow = window.open("", `mew-editor-${session}`);
      try { if (pairedWindow?.location.href === "about:blank") { pairedWindow.close(); pairedWindow = null; } } catch { pairedWindow = null; }
    }
    try { if (pairedWindow && !pairedWindow.closed) attachEditor(pairedWindow.mewWorkbench?.editor); } catch { /* editor is navigating */ }
    if (window.PDFViewerApplication?.pdfViewer) attachViewer(window.PDFViewerApplication.pdfViewer);
    void discoverPdf();
  }
  listen(window, "reader-visual-ready", event => attachVisual(event.detail?.document));
  listen(document, "selectionchange", selectFromPdf);
  listen(window, "resize", schedule);
  listen(window, "pagehide", () => api.stop());
  const originalOpen = window.open;
  function open(...args) {
    const popup = originalOpen.apply(this, args);
    if (String(args[1] || "").startsWith("mew-editor-")) {
      pairedWindow = popup; pairedSession = String(args[1]).slice("mew-editor-".length);
    }
    return popup;
  }
  window.open = open;
  cleanup.push(() => { if (window.open === open) window.open = originalOpen; });
  const poll = setInterval(discover, 500);
  cleanup.push(() => clearInterval(poll));
  discover();
  function selectFromPdf() {
    if (stopped || syncingPdf || !viewer) return;
    const native = document.getSelection();
    if (!native?.rangeCount || native.isCollapsed) { if (status.mode === "pdf-selection") select([]); return; }
    const range = native.getRangeAt(0), chunks = [];
    const ancestor = range.commonAncestorContainer;
    const page = (ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement)?.closest(".page");
    const pages = page && viewer.viewer.contains(page) ? [page] : viewer.viewer.querySelectorAll(".page");
    for (const div of pages) {
      const layer = div.querySelector(".textLayer");
      if (!layer || !range.intersectsNode(layer)) continue;
      const index = layerIndex(div);
      let start = null, end = null;
      for (const part of index.parts) {
        if (!range.intersectsNode(part.node)) continue;
        const a = range.startContainer === part.node ? range.startOffset : 0, b = range.endContainer === part.node ? range.endOffset : part.node.length;
        if (a >= b) continue;
        start ??= part.start + a; end = part.start + b;
      }
      if (start !== null) chunks.push({ div, index, start, end });
    }
    if (!chunks.length) return;
    let editor = activeEditor;
    try { editor = (!pairedWindow?.closed && pairedWindow?.mewWorkbench?.editor) || editor; } catch { /* editor is navigating */ }
    const model = editor?.getModel();
    if (!model || !editor.setSelection) return;
    const index = editorSourceIndex(model), { hit, difference } = diff.locateSource(index, chunks);
    select([]);
    if (difference) {
      for (const chunk of chunks) {
        const result = nativeBoxes(chunk.div, [], [{ range: { start: chunk.start, end: chunk.end }, difference }]);
        paint(chunk.div, result.boxes, result.notices.map(notice => ({ ...notice, source: hit && { index, start: hit.start, end: hit.end } })));
      }
      report("idle", { mode: "pdf-selection", differences: [difference] });
    }
    if (!hit) return; // An ambiguous match must not move the editor selection.
    updateEditorMarks();
    const start = model.getPositionAt(index.starts[hit.start]), end = model.getPositionAt(index.ends[hit.end - 1]);
    const target = { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
    syncingPdf = true;
    try {
      editor.setSelection(target);
      editor.revealRangeInCenterIfOutsideViewport?.(target);
    } finally { syncingPdf = false; }
  }
  function visiblePages() {
    const visible = viewer._getVisiblePages?.().views;
    if (visible?.length) return visible.map(page => page.id);
    const rect = viewer.container.getBoundingClientRect(), pages = [];
    for (const div of viewer.viewer.querySelectorAll(".page[data-page-number]")) {
      const box = div.getBoundingClientRect();
      if (box.bottom > rect.top && box.top < rect.bottom && box.right > rect.left && box.left < rect.right) {
        pages.push(Number(div.dataset.pageNumber));
      }
    }
    return pages.length ? pages : [viewer.currentPageNumber];
  }
  function layerIndex(div) {
    const layer = div?.querySelector(".textLayer");
    if (!layer) return null;
    const cached = layers.get(div);
    if (cached?.layer === layer && cached.pdf === viewer?.pdfDocument && cached.width === div.clientWidth && cached.height === div.clientHeight && !cached.observer.takeRecords().length) return cached;
    clearLayer(div);
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT), parts = [];
    let raw = "", previous = null, node;
    while ((node = walker.nextNode())) {
      if (!node.textContent) continue;
      const box = node.parentElement.getBoundingClientRect();
      if (previous) {
        const lineBreak = Math.abs(box.top - previous.top) > Math.min(box.height, previous.height) * 0.5;
        if (lineBreak) raw += "\n";
        else if (box.left - previous.right > Math.min(box.height, previous.height) * 0.08) raw += " ";
      }
      parts.push({ node, start: raw.length, end: raw.length + node.textContent.length });
      raw += node.textContent; previous = box;
    }
    const observer = new MutationObserver(() => clearLayer(div));
    observer.observe(layer, { subtree: true, childList: true, characterData: true, attributes: true });
    const index = { layer, raw, parts, normalized: normalized(raw), observer, pdf: viewer?.pdfDocument, width: div.clientWidth, height: div.clientHeight };
    layers.set(div, index);
    return index;
  }
  function nativeBoxes(div, queries, targets = []) {
    const index = layerIndex(div);
    if (!index) return { boxes: [], count: 0, pending: true };
    const { parts } = index;
    const key = JSON.stringify([queries, targets.map(target =>
      [target.text, target.before, target.after, target.difference, target.range, target.start, target.end, target.marked])]);
    let cached = pageResults.get(div);
    if (cached?.index !== index || cached.source !== contexts[0]?.index) {
      cached = { index, source: contexts[0]?.index, results: new Map() };
      pageResults.set(div, cached);
    }
    if (cached.results.has(key)) return cached.results.get(key);
    const { hits, focusHit } = diff.locateLayer(index, queries, targets);
    const boxes = [], notices = [];
    let focus = null;
    for (const hit of hits) {
      let noticeBox = null;
      // One DOM Range covers the selection across spans; measure layout once.
      const first = parts[Math.min(parts.length - 1, lowerBound(parts, hit.start + 1, part => part.end))];
      const last = hit.start === hit.end ? first : parts[lowerBound(parts, hit.end, part => part.end)];
      if (first && last && (first.start < hit.end || hit.start === hit.end)) {
        const range = document.createRange();
        range.setStart(first.node, Math.max(0, hit.start - first.start));
        range.setEnd(last.node, Math.max(0, Math.min(last.node.length, hit.end - last.start)));
        for (let box of range.getClientRects()) if ((box.width || hit.start === hit.end) && box.height) {
          if (!box.width) box = { left: box.left, right: box.left + 2, top: box.top, width: 2, height: box.height };
          const previous = boxes.at(-1);
          // Range rects can include both a span and its text, or adjoining spans.
          if (previous && Math.abs(previous.top - box.top) < .5 && Math.abs(previous.height - box.height) < .5
            && box.left >= previous.left && box.left <= previous.right + .5) {
            boxes[boxes.length - 1] = { left: previous.left, top: previous.top, width: Math.max(previous.right, box.right) - previous.left,
              height: previous.height, right: Math.max(previous.right, box.right) };
          } else boxes.push(box);
          if (hit.difference) noticeBox = noticeBox ? { left: Math.min(noticeBox.left, box.left), top: Math.min(noticeBox.top, box.top),
            width: Math.max(noticeBox.right, box.right) - Math.min(noticeBox.left, box.left), right: Math.max(noticeBox.right, box.right),
            height: Math.max(noticeBox.top + noticeBox.height, box.top + box.height) - Math.min(noticeBox.top, box.top) } : box;
          if (hit === focusHit && !focus) focus = box;
        }
      }
      if (noticeBox) notices.push({ box: noticeBox, ...hit.difference, source: hit.source });
    }
    const pageBox = div.getBoundingClientRect();
    const sx = pageBox.width / div.offsetWidth, sy = pageBox.height / div.offsetHeight;
    const relative = box => ({
      x: (box.left - pageBox.left - div.clientLeft * sx) / (div.clientWidth * sx),
      y: (box.top - pageBox.top - div.clientTop * sy) / (div.clientHeight * sy),
      w: box.width / (div.clientWidth * sx), h: box.height / (div.clientHeight * sy)
    });
    const result = { count: hits.length, focus: focus && relative(focus), boxes: boxes.map(relative), notices: notices.map(notice => ({ ...notice, box: relative(notice.box) })) };
    cached.results.set(key, result);
    if (cached.results.size > 32) cached.results.delete(cached.results.keys().next().value);
    return result;
  }
  function paint(div, boxes, notices = []) {
    const previous = overlays.get(div);
    if (previous?.boxes === boxes && previous.node.isConnected) return;
    if (!boxes.length) {
      removeOverlay(previous);
      overlays.delete(div);
      return;
    }
    const overlay = previous?.node.isConnected ? previous.node : document.createElement("div");
    if (!overlay.isConnected) {
      overlay.className = "mew-pdf-selection-highlight";
      overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:20;overflow:hidden;contain:strict;";
      div.append(overlay);
    }
    previous?.popups?.forEach(node => node.remove());
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      let mark = overlay.children[i];
      if (!mark) {
        mark = document.createElement("div");
        mark.setAttribute("aria-hidden", "true");
        overlay.append(mark);
      }
      mark.style.cssText = `position:absolute;left:${box.x * 100}%;top:${box.y * 100}%;width:${box.w * 100}%;height:${box.h * 100}%;border-radius:2px;pointer-events:none;`;
      mark.style.background = options.color;
    }
    while (overlay.children.length > boxes.length) overlay.lastElementChild.remove();
    const painted = { node: overlay, boxes, popups: [] };
    overlays.set(div, painted);
    const showNotices = () => {
      if (!diffHighlight || !overlay.isConnected || overlays.get(div) !== painted) return;
      for (const notice of notices) {
        const popup = document.createElement("aside");
        popup.className = "mew-pdf-selection-difference";
        popup.setAttribute("role", "status");
        const close = document.createElement('button');
        close.type = 'button'; close.className = 'mew-diff-close'; close.textContent = '×';
        close.setAttribute('aria-label', 'Close diff'); close.title = 'Close diff';
        close.addEventListener('pointerdown', event => event.preventDefault());
        close.onclick = () => popup.remove();
        popup.append(close);
        const title = document.createElement("strong"); title.textContent = notice.message || "Text differs"; popup.append(title);
        // Cache the original-text comparison on the existing geometry result.
        const parts = notice.message ? [] : (notice.parts ||= window.PdfSelectionDiff.monacoDiff(notice.html, notice.pdf)?.parts
          || [{ html: notice.html, pdf: notice.pdf, changed: false }]);
        for (const side of notice.message ? [] : ['html', 'pdf']) {
          const line = document.createElement("div"); line.append(`${side.toUpperCase()}: `);
          for (const part of parts) if (part[side]) {
            const span = document.createElement(part.changed ? "mark" : "span");
            span.textContent = part[side];
            line.append(span);
          }
          popup.append(line);
        }
        const editor = activeEditor, model = editor?.getModel(), source = notice.source;
        if (source && model && editorSourceIndex(model) === source.index && editor.executeEdits
          && !editor.getOption?.(editor.getDomNode?.()?.ownerDocument.defaultView.monaco?.editor.EditorOption.readOnly ?? 104)) {
          const button = document.createElement('button'); button.textContent = 'Replace with PDF text';
          button.addEventListener('pointerdown', event => event.preventDefault());
          button.onclick = () => {
            if (editor.getModel() !== model || editorSourceIndex(model) !== source.index) return;
            const index = source.index, segments = [];
            for (let at = source.start; at < source.end; at++) {
              const start = index.starts[at], end = index.ends[at], last = segments.at(-1);
              if (index.source.slice(start, end).startsWith('<')) continue;
              if (last && start <= last.end) last.end = Math.max(last.end, end);
              else segments.push({ start, end });
            }
            if (!segments.length) { const at = index.starts[source.start] ?? index.ends[source.start - 1] ?? 0; segments.push({ start: at, end: at }); }
            const text = notice.pdf.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const edits = segments.map(({ start, end }, i) => {
              const a = model.getPositionAt(start), b = model.getPositionAt(end);
              return { range: { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column }, text: i ? '' : text };
            });
            editor.pushUndoStop?.(); editor.executeEdits('pdf-ocr-replacement', edits); editor.pushUndoStop?.(); editor.focus?.();
          };
          popup.append(button);
        }
        const page = div.getBoundingClientRect(), viewport = viewer.container.getBoundingClientRect();
        const sx = page.width / div.offsetWidth, sy = page.height / div.offsetHeight;
        const originX = page.left + div.clientLeft * sx, originY = page.top + div.clientTop * sy;
        const left = Math.max(originX, viewport.left, 0) + 4, right = Math.min(page.right, viewport.right, innerWidth) - 4;
        const top = Math.max(originY, viewport.top, 0) + 4, bottom = Math.min(page.bottom, viewport.bottom, innerHeight) - 4;
        const anchorTop = originY + notice.box.y * div.clientHeight * sy;
        const anchorBottom = anchorTop + notice.box.h * div.clientHeight * sy;
        popup.style.width = 'max-content';
        popup.style.maxWidth = `${Math.max(0, Math.min(480, (right - left) / sx))}px`;
        div.append(popup); painted.popups.push(popup);
        const below = Math.max(0, bottom - anchorBottom - 6), above = Math.max(0, anchorTop - top - 6);
        const placeBelow = popup.getBoundingClientRect().height <= below || below >= above;
        popup.style.maxHeight = `${Math.max(0, Math.min(innerHeight * .4, placeBelow ? below : above)) / sy}px`;
        const size = popup.getBoundingClientRect();
        popup.style.left = `${(Math.max(left, Math.min(originX + notice.box.x * div.clientWidth * sx, right - size.width)) - originX) / sx}px`;
        popup.style.top = `${((placeBelow ? anchorBottom + 6 : anchorTop - size.height - 6) - originY) / sy}px`;
      }
    };
    // Populate comparison popups after the highlight, including short OCR differences.
    if (notices.length) setTimeout(showNotices, 0);
  }
  async function refresh(run) {
    if (!contexts.length || !viewer?.pdfDocument || stopped) return;
    const instance = viewer, pdf = instance.pdfDocument, results = [];
    const current = () => !stopped && run === revision && instance === viewer && pdf === viewer.pdfDocument;
    if (!locationSearch || locationSearch.pdf !== pdf) {
      report("searching", { error: null });
      const entries = contexts.slice();
      const found = diff.findLocations(pdf, entries);
      const search = locationSearch = { pdf, locations: Array.isArray(found) ? found : null };
      const complete = locations => {
        if (stopped || locationSearch !== search || viewer?.pdfDocument !== pdf) return;
        search.locations = locations;
        schedule(-1);
      };
      if (!search.locations) Promise.resolve(found).then(complete, error => {
        console.warn("[PDF selection highlight] Context search unavailable:", error);
        complete(entries.map(entry => ({ entry, targets: [] })));
      });
    }
    const locations = locationSearch.locations;
    updateEditorMarks();
    const exact = locations?.flatMap(location => location.targets) || [];
    const queries = locations?.filter(location => !location.targets.length).flatMap(location => location.queries || [location.entry.text]) || [];
    if (!positioned && exact.length) {
      await Promise.resolve();
      if (!current()) return;
      const target = exact[0], view = instance.getPageView(target.pageNumber - 1);
      const focus = view?.div && nativeBoxes(view.div, queries, exact.filter(entry => entry.pageNumber === target.pageNumber)).focus;
      if (focus) {
        positioned = true;
        const container = instance.container, rect = container.getBoundingClientRect(), box = view.div.getBoundingClientRect();
        const left = box.left + (view.div.clientLeft + focus.x * view.div.clientWidth) * box.width / view.div.offsetWidth,
          top = box.top + (view.div.clientTop + focus.y * view.div.clientHeight) * box.height / view.div.offsetHeight;
        const vertical = top < rect.top + container.clientTop || top + focus.h * box.height > rect.top + container.clientTop + container.clientHeight;
        const horizontal = left < rect.left + container.clientLeft || left + focus.w * box.width > rect.left + container.clientLeft + container.clientWidth;
        if (vertical || horizontal) {
          container.scrollBy({ top: vertical ? top - rect.top - 48 : 0, left: horizontal ? left - rect.left - 24 : 0 });
        }
      } else if (!scrolled && (!visiblePages().includes(target.pageNumber)
        || target.item && !view?.div?.querySelector(".textLayer")?.textContent)) {
        scrolled = true;
        const item = target.item;
        instance.scrollPageIntoView({ pageNumber: target.pageNumber,
          destArray: item ? [null, { name: "XYZ" }, item.transform[4], item.transform[5] + item.height, null] : null });
      }
      if (!current()) return;
    }
    const numbers = visiblePages(), visible = new Set(numbers.map(number => instance.getPageView(number - 1)?.div));
    for (const [div, painted] of overlays) if (!visible.has(div)) { removeOverlay(painted); overlays.delete(div); }
    for (const number of numbers) {
      const view = instance.getPageView(number - 1);
      if (!view?.div) continue;
      if (!current()) return;
      const result = nativeBoxes(view.div, queries, locations ? exact.filter(target => target.pageNumber === number) : contexts);
      paint(view.div, result.boxes, result.notices);
      results.push({ pageNumber: number, source: "pdf-text", matches: result.count, pending: !!result.pending });
    }
    if (current()) report(locations ? "idle" : "searching", { pages: results, mode: exact.length ? (queries.length ? "mixed" : "exact") : "fallback",
      differences: exact.filter(target => target.difference).map(target => ({ pageNumber: target.pageNumber, ...target.difference })),
      matches: results.reduce((sum, page) => sum + page.matches, 0) });
  }
})().catch(error => console.error(error));
