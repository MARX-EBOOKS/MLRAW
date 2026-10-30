// ==UserScript==
// @name         MEW PDF selection highlight
// @namespace    mew-local
// @version      1.9.0
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
// Reader selection attachment; review owns loading and rendering. See pdf-selection.md.
(async () => {
  "use strict";
  if (typeof window === "undefined" || window.PdfSelection) return;
  if (!window.PdfReviewReady) await import('./pdf-review-provider.js');
  const review = await window.PdfReviewReady;
  if (window.PdfSelection) return;
  const { significantText, PdfSourceIndex, lowerBound } = window.PdfSelectionDiff;
  const options = {
    viewerModuleUrl: "/vendor/pdfjs/web/pdf_viewer.mjs",
    color: "rgba(255, 196, 0, 0.42)", wholeWords: false,
    ...window.PdfSelectionOptions
  };
  const cleanup = [], editors = new WeakSet(), selectionDocuments = new WeakSet();
  let selecting = false, pendingDifference = null;
  const layers = new Map();
  const pageResults = new WeakMap();
  const preparationPages = new Set();
  const editIdleDelay = 350;
  let preparationTask = null, lastInteraction = 0, lastIndexYield = 0, lastEdit = -Infinity;
  let activeEditor = null, syncingPdf = false, contexts = [], locationSearch = null, scrolled = false, positioned = false;
  let reviewPointer = null, defaultPointer = null;
  let viewer = null, revision = 0, timer, stopped = false, hooking = false, diffHighlight = true, sourceDiffHighlight = true, selectionHighlight = true;
  let preferenceWrites = Promise.resolve(), selectionRevision = 0, notifiedSelection = -1, interactionId = 0;
  try {
    const response = await fetch('/api/reader/settings');
    if (response.ok) {
      const settings = await response.json();
      diffHighlight = settings.diffHighlight !== false;
      sourceDiffHighlight = (settings.sourceDiffHighlight ?? settings.diffHighlight) !== false;
      selectionHighlight = settings.selectionHighlight !== false;
      for (const key of ['italic', 'bold']) review.setFontEnabled(settings[`${key}Detection`] !== false, key, false);
      window.ReplacementReview.refreshMenu();
    }
  } catch {}
  let visualDocument = null, detachVisual = () => {};
  let pairedWindow = null, pairedSession = "";
  function currentEditor() {
    try { return window.ReaderUI?.getSourceEditor
      ? window.ReaderUI.getSourceEditor(pairedWindow && !pairedWindow.closed ? pairedWindow.mewWorkbench : null)
      : activeEditor; } catch { return null; }
  }
  const sourcePages = () => window.ReaderUI?.getPdfSourcePages?.();
  const locator = new review.PdfLocator(options, {
    document, getPdf: () => viewer?.pdfDocument, getSourcePages: sourcePages,
    getTargets() {
      const pdf = viewer?.pdfDocument, numbers = sourcePages();
      if (window.ReaderUI?.getSourceEditor && !currentEditor()) return [];
      return [...new Set([...layers.values()].filter(page => page.pdf === pdf
        && (!numbers || numbers.includes(Number(page.layer.closest('.page')?.dataset.pageNumber)))).concat(
        locator.getDocumentIndex(pdf, numbers) || []))];
    },
    getVisiblePages: (numbers = sourcePages()) => visiblePages().filter(number => !numbers || numbers.includes(number)).map(number => ({ number, index: layerIndex(viewer.getPageView(number - 1)?.div) })),
    isCurrent: pdf => !stopped && viewer?.pdfDocument === pdf,
    async waitForIdle(pdf) {
      while (!stopped && viewer?.pdfDocument === pdf
        && (performance.now() - lastInteraction < 100 || performance.now() - lastEdit < editIdleDelay))
        await new Promise(resolve => setTimeout(resolve, 25));
      if (performance.now() - lastIndexYield >= 8) {
        await new Promise(resolve => setTimeout(resolve, 0));
        lastIndexYield = performance.now();
      }
    },
    onIndexed: () => queueWarm()
  });
  cleanup.push(() => detachVisual());
  const status = { state: "waiting-for-pdf", pages: [], matches: 0, differences: [], error: null };
  const api = window.PdfSelection = {
    status, locator, attachEditor, attachViewer, savePreference, refresh: publishSources,
    highlight: text => select(Array.isArray(text) ? text : [text]),
    clear: () => select([]),
    showReviewPointer(editor, items, key) {
      if (key && defaultPointer?.key === key && currentPointer(defaultPointer)) return;
      review.clearHighlights(true);
      if (!key) reviewPointer = null;
      const model = editor?.getModel();
      if (!model || !viewer?.pdfDocument || key && !diffHighlight || !items?.length && !key) return;
      const index = locator.editorSourceIndex(model), data = locator.reviewLists.get(items);
      const entries = data?.index === index ? data.entries : items.map(item => locator.sourceEntry(index, item.sourceStart, item.sourceEnd, true));
      const pointer = { editor, model, version: model.getVersionId?.(), pdf: viewer?.pdfDocument, entries, key };
      if (key) defaultPointer = pointer;
      else if (!selectionHighlight) reviewPointer = pointer;
      else if (!entries.every(entry => contexts.some(context => context.index === index && context.start <= entry.start && context.end >= entry.end)))
        return select(entries, true);
      schedule();
    },
    clearReviewPointer(editor) {
      if (editor && (reviewPointer || defaultPointer)?.editor !== editor) return;
      review.clearHighlights(true);
      if (defaultPointer && (stopped || !currentPointer(defaultPointer))) defaultPointer = null;
      reviewPointer = null;
      if (defaultPointer) schedule();
    },
    setDiffHighlight(enabled, side = 'pdf') {
      if (side === 'source') sourceDiffHighlight = !!enabled;
      else {
        diffHighlight = !!enabled;
        defaultPointer = null;
        review.clearHighlights(true);
        if (reviewPointer) schedule();
      }
      savePreference(side === 'source' ? 'sourceDiffHighlight' : 'diffHighlight', !!enabled, '无法保存差异高亮设置');
      publishSources();
      if (enabled) queueWarm();
      if (diffButton) {
        diffButton.textContent = diffHighlight ? '关闭差异高亮' : '显示差异高亮';
        diffButton.setAttribute('aria-pressed', String(diffHighlight));
      }
    },
    setSelectionHighlight(enabled) {
      selectionHighlight = !!enabled;
      savePreference('selectionHighlight', selectionHighlight, '无法保存选区联动设置');
      select([]);
      if (selectionHighlight) queueWarm();
    },
    get selectionEnabled() { return selectionHighlight; },
    stop() {
      stopped = true;
      resetPdf();
      clearTimeout(preparationTask);
      cleanup.splice(0).reverse().forEach(dispose => dispose());
      delete window.PdfSelection;
    },
    get viewer() { return viewer; },
    get editor() { return currentEditor(); },
    get enabled() { return diffHighlight; },
    get sourceEnabled() { return sourceDiffHighlight; },
    get interactionId() { return interactionId; }
  };
  function savePreference(key, value, message) {
    preferenceWrites = preferenceWrites.then(async () => {
      const response = await fetch('/api/reader/settings', { method: 'PUT',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [key]: value }) });
      if (!response.ok) throw new Error(message);
    }).catch(() => window.ReaderUI?.notify(message, true));
  }
  function report(state, detail = {}) {
    Object.assign(status, { state }, detail); window.dispatchEvent(new CustomEvent("pdf-selection-highlight-status", { detail: { ...status } }));
  }
  function listen(target, name, callback, options) {
    target.addEventListener(name, callback, options); cleanup.push(() => target.removeEventListener(name, callback, options));
  }
  const diffButton = document.getElementById('diffHighlightBtn');
  if (diffButton) {
    diffButton.disabled = false;
    diffButton.textContent = diffHighlight ? '关闭差异高亮' : '显示差异高亮';
    diffButton.setAttribute('aria-pressed', String(diffHighlight));
    listen(diffButton, 'click', () => api.setDiffHighlight(!diffHighlight));
  }
  function clearLayers() { for (const div of layers.keys()) clearLayer(div); }
  function clearLayer(div, records) {
    if (records && !records.some(({ type, target, addedNodes, removedNodes }) => type === 'childList'
      ? [...addedNodes, ...removedNodes].some(node => node.textContent)
      : type === 'characterData' || target !== layers.get(div)?.layer && target.textContent)) return false;
    layers.get(div)?.observer.disconnect(); return layers.delete(div);
  }
  function currentPointer(pointer) {
    return pointer.pdf === viewer?.pdfDocument && pointer.editor === currentEditor() && pointer.model === pointer.editor.getModel()
      && pointer.version === pointer.model.getVersionId?.();
  }
  function resetPdf() {
    defaultPointer = null;
    api.clearReviewPointer();
    ++revision;
    clearTimeout(timer);
    review.clearHighlights();
    clearLayers();
    window.dispatchEvent(new CustomEvent('pdf-selection-reset'));
  }
  function select(entries, plain = false) {
    if (!selectionHighlight && entries.length) return;
    ++selectionRevision;
    if (entries.length) lastInteraction = performance.now();
    const decode = text => (plain ? String(text || "") : locator.sourceIndex(String(text || "")).raw).trim();
    contexts = entries.map(input => {
      const entry = input && typeof input === 'object' ? input : { text: input }, text = entry.text, value = entry.marked ? text : decode(text);
      const start = entry.start + (plain && !entry.marked ? text.length - text.trimStart().length : 0);
      return { text: value, before: decode(entry.before || "").slice(-160),
        after: decode(entry.after || "").slice(0, 160), index: entry.index, start, end: start + value.length, marked: entry.marked };
    }).filter(entry => entry.text || entry.marked);
    status.differences = [];
    locationSearch = null;
    scrolled = positioned = false;
    if (!contexts.length) {
      review.clearHighlights();
      report(viewer ? "idle" : "waiting-for-pdf", { pages: [], matches: 0, mode: null, differences: [], error: null });
    }
    schedule();
    return api;
  }
  function schedule(delay = 0) {
    if (stopped) return;
    ++revision;
    clearTimeout(timer);
    const run = revision;
    const execute = () => Promise.all([refresh(run), refreshReviewPointer()]).catch(error => {
      if (stopped || run !== revision) return;
      report("error", { error: error.message });
      console.error("[PDF selection highlight]", error);
    });
    if (delay === -1) execute();
    else timer = setTimeout(execute, typeof delay === "number" ? delay : 0);
  }
  function attachEditor(editor) {
    editor = editor?.editor || editor;
    if (window.ReaderUI?.getSourceEditor && editor !== currentEditor()) return;
    const editorApi = editor?.getDomNode?.()?.ownerDocument.defaultView.monaco || window.monaco;
    if (editorApi && editor?.getOption?.(editorApi.editor.EditorOption.inDiffEditor)) return;
    if (!editor?.onDidChangeCursorSelection || editors.has(editor)) return;
    editors.add(editor);
    activeEditor = editor;
    const node = editor.getDomNode?.();
    if (node) {
      trackSelection(node.ownerDocument);
      const interact = () => { lastInteraction = performance.now(); };
      for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) listen(node, name, interact, { passive: true });
    }
    let readTimer = null;
    cleanup.push(() => clearTimeout(readTimer));
    const read = event => {
      if (syncingPdf || window.ReaderUI?.getSourceEditor && editor !== currentEditor()) return;
      if (event?.changes || readTimer !== null) {
        if (event?.changes) lastEdit = event.isFlush ? -Infinity : performance.now();
        if (readTimer === null) select([]);
        clearTimeout(readTimer);
        readTimer = setTimeout(() => { readTimer = null; read(); }, Math.max(0, editIdleDelay - (performance.now() - lastEdit)));
        return;
      }
      if (!selectionHighlight) { queueWarm(); return; }
      activeEditor = editor;
      const model = editor.getModel();
      let marked = false;
      const ranges = model ? (editor.getSelections() || []).map(range => {
        const mark = review.selectionRange(editor, event, range);
        if (mark) { marked = true; return mark; }
        return range;
      }) : [];
      if (!marked && !ranges.some(range => model.getOffsetAt(range.getEndPosition()) > model.getOffsetAt(range.getStartPosition()))) { select([]); if (viewer) queueWarm(); return; }
      const index = locator.editorSourceIndex(model);
      if (viewer && index.preparation?.pdf !== viewer.pdfDocument) queueWarm();
      const entries = ranges.map(range => {
        const start = model.getOffsetAt(range.getStartPosition()), end = model.getOffsetAt(range.getEndPosition());
        const a = lowerBound(index.ends, start + 1), b = lowerBound(index.starts, end);
        return locator.sourceEntry(index, a, b, marked, end > start ? undefined : "");
      });
      select(entries, true);

    };
    for (const name of ["onDidChangeCursorSelection", "onDidChangeModel", "onDidChangeModelContent"]) {
      const subscription = editor[name]?.(read);
      if (subscription) cleanup.push(() => subscription.dispose());
    }
    const click = editor.onMouseUp?.(event => {
      if (event.target?.position && event.target.type !== 9) {
        ++interactionId;
        read({ position: event.target.type === 6 && !event.target.detail?.injectedText
          ? event.target.range?.getStartPosition() || event.target.position : event.target.position,
          clientX: event.event?.posx,
          lineRange: event.target.type === 4 ? event.target.range : null });
      }
    });
    if (click) cleanup.push(() => click.dispose());
    if (viewer) warm();
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
        select([{ text: range.toString(), before: before.toString(), after: after.toString() }], true);
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
    listen(instance.container, 'pointerdown', () => { ++interactionId; }, { passive: true });
    listen(instance.container, "keydown", event => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) manualScroll();
    });
    for (const event of ["pagesinit", "pagechanging", "pagerendered", "textlayerrendered", "scalechanging", "rotationchanging", "updateviewarea"]) {
      const update = data => {
        if (viewer !== instance) return;
        if (event === "textlayerrendered") clearLayer(instance.getPageView(data?.pageNumber - 1)?.div);
        if (["pagesinit", "scalechanging", "rotationchanging"].includes(event)) { clearLayers(); review.clearHighlights(); }
        if (event === "textlayerrendered" && performance.now() - lastEdit >= editIdleDelay) {
          warm([data.pageNumber]);
          void refreshReviewPointer().catch(error => console.warn('[PDF selection highlight] Pointer unavailable:', error));
        }
        else queueWarm(data?.pageNumber);
        if (contexts.length || reviewPointer) schedule();
      };
      instance.eventBus.on(event, update);
      cleanup.push(() => instance.eventBus.off(event, update));
    }
    const destroyed = () => { if (viewer === instance) resetPdf(); };
    instance.eventBus.on("pagesdestroy", destroyed);
    cleanup.push(() => instance.eventBus.off("pagesdestroy", destroyed));
    report("idle");
    queueWarm();
    schedule();
  }
  function queueWarm(number) {
    if (stopped || (!diffHighlight && !sourceDiffHighlight && !selectionHighlight)) return;
    preparationPages.add(number);
    if (preparationTask !== null) return;
    preparationTask = setTimeout(() => {
      preparationTask = null;
      if (stopped) return;
      if (performance.now() - lastInteraction < 100 || performance.now() - lastEdit < editIdleDelay) { queueWarm(number); return; }
      const numbers = [...preparationPages].filter(number => number !== undefined);
      if (preparationPages.has(undefined)) numbers.push(...visiblePages());
      preparationPages.clear();
      warm([...new Set(numbers)]);
      if (contexts.length) { locationSearch = null; schedule(); }
      else if (reviewPointer) schedule();
    }, Math.max(0, 100 - (performance.now() - lastInteraction), editIdleDelay - (performance.now() - lastEdit)));
  }
  function warm(numbers = visiblePages()) {
    if (!viewer?.pdfDocument) return;
    const pdf = viewer?.pdfDocument, model = currentEditor()?.getModel(), source = model && locator.editorSourceIndex(model);
    for (const div of layers.keys()) if (!div.isConnected) clearLayer(div);
    for (const number of numbers) layerIndex(viewer.getPageView(number - 1)?.div);
    const scope = window.ReaderUI?.getPdfSourcePages?.();
    if (source && scope?.length && !locator.getDocumentIndex(pdf, scope))
      void locator.indexDocument(pdf, scope).catch(error => console.warn('[PDF selection highlight] Source pages unavailable:', error));
    publishSources();
  }
  function publishSources() {
    if (performance.now() - lastEdit < editIdleDelay) return;
    const pdf = viewer?.pdfDocument;
    const editor = currentEditor();
    const index = editor?.getModel() && locator.editorSourceIndex(editor.getModel());
    const targets = locator.environment.getTargets();
    window.dispatchEvent(new CustomEvent('pdf-selection-sources', { detail: {
      editor: editor || activeEditor, pdf, targets, enabled: sourceDiffHighlight, diffEnabled: diffHighlight,
      index
    } }));
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
      attachViewer(window.ReaderUI?.getPdfViewer?.() || window.PDFViewerApplication?.pdfViewer);
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
    attachViewer(window.ReaderUI?.getPdfViewer?.() || window.PDFViewerApplication?.pdfViewer);
    void discoverPdf();
  }
  listen(window, "reader-visual-ready", event => attachVisual(event.detail?.document));
  trackSelection(document);
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
  function trackSelection(doc) {
    if (selectionDocuments.has(doc)) return;
    selectionDocuments.add(doc);
    let preserving = false;
    listen(doc, 'pointerdown', event => {
      preserving = event.button === 0 && event.returningToWindow
        && (viewer?.container.contains(event.target) || event.target.closest?.('.monaco-editor'));
      if (preserving) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.button === 0) selecting = true;
    }, true);
    const release = event => {
      selecting = false;
      if (preserving) { preserving = false; return; }
      const publish = pendingDifference;
      pendingDifference = null;
      if (event.type === 'pointerup' && event.button === 0) {
        if (publish) setTimeout(publish, 0);
      } else notifiedSelection = selectionRevision;
      if (doc === document && event.type === 'pointerup' && event.button === 0) selectFromPdf(event);
    };
    listen(doc, 'pointerup', release, true);
    listen(doc, 'pointercancel', release, true);
    listen(doc.defaultView, 'blur', release);
  }
  function selectFromPdf(event) {
    if (stopped || syncingPdf || !viewer) return;
    const native = document.getSelection();
    if (!native?.rangeCount || native.isCollapsed) {
      if (status.mode === "pdf-selection") select([]);
      const div = event?.target?.closest?.('.page'), painted = div && review.getHighlight(div, true);
      const page = div?.getBoundingClientRect();
      const x = page && (event.clientX - page.left) / page.width;
      const notice = painted?.notices?.filter(({ box }) => box
        && event.clientX >= page.left + box.x * page.width - 3 && event.clientX <= page.left + (box.x + box.w) * page.width + 3
        && event.clientY >= page.top + box.y * page.height && event.clientY <= page.top + (box.y + box.h) * page.height)
        .sort(({ box: a, missing: am }, { box: b, missing: bm }) => Math.max(a.x - x, x - a.x - a.w, 0) - Math.max(b.x - x, x - b.x - b.w, 0)
          || Math.abs(x - a.x - a.w / 2) - Math.abs(x - b.x - b.w / 2) || Number(!!bm) - Number(!!am))[0];
      if (notice) { notifiedSelection = null; publishDifferences(div, painted, [notice], true); }
      else if (event?.type === 'pointerup' && viewer.container.contains(event.target)) {
        api.clearReviewPointer();
        select([]);
      }
      return;
    }
    if (!selectionHighlight || event?.type === 'pointerup') return;
    const range = native.getRangeAt(0), chunks = [];
    const ancestor = range.commonAncestorContainer;
    const page = (ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement)?.closest(".page");
    const pages = page && viewer.viewer.contains(page) ? [page] : viewer.viewer.querySelectorAll(".page");
    for (const div of pages) {
      const layer = div.querySelector(".textLayer");
      if (!layer || !range.intersectsNode(layer)) continue;
      if (sourcePages() && !sourcePages().includes(Number(div.dataset.pageNumber))) return;
      const index = layerIndex(div);
      let start = 0, end = index.raw.length;
      for (const part of index.parts) {
        if (range.startContainer === part.node) start = part.start + range.startOffset;
        if (range.endContainer === part.node) end = part.start + range.endOffset;
      }
      if (start !== end) chunks.push({ div, index, start: Math.min(start, end), end: Math.max(start, end) });
    }
    if (!chunks.length) return;
    let editor = currentEditor();
    if (!window.ReaderUI?.getSourceEditor) {
      try { editor = (!pairedWindow?.closed && pairedWindow?.mewWorkbench?.editor) || editor; } catch { /* editor is navigating */ }
    }
    const model = editor?.getModel();
    if (!model || !editor.setSelection) return;
    activeEditor = editor;
    const index = locator.editorSourceIndex(model), { hit, difference } = locateSource(index, chunks);
    select([]);
    for (const chunk of chunks) {
      const result = nativeBoxes(chunk.div, [], [{ range: { start: chunk.start, end: chunk.end }, difference }]);
      paint(chunk.div, result.boxes, result.notices.map(notice => ({ ...notice, source: hit && { index, start: hit.start, end: hit.end } })));
    }
    report("idle", { mode: "pdf-selection", differences: difference ? [difference] : [] });
    if (!hit) return; // An ambiguous match must not move the editor selection.
    publishSources();
    const target = window.PdfSelectionDiff.rangeAt(model, index.starts[hit.start] ?? index.source.length,
      (hit.end > hit.start ? index.ends[(hit.end) - 1] : index.starts[hit.start]) ?? index.source.length);
    syncingPdf = true;
    try {
      editor.setSelection(target);
      editor.revealRangeInCenterIfOutsideViewport?.(target);
    } finally { syncingPdf = false; }
  }
  function visiblePages() {
    if (!viewer?.pdfDocument) return [];
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
    if (!layer || !layer.getClientRects().length) return null;
    const cached = layers.get(div);
    if (cached?.layer === layer && cached.pdf === viewer?.pdfDocument && cached.width === div.clientWidth && cached.height === div.clientHeight && !clearLayer(div, cached.observer.takeRecords())) return cached;
    clearLayer(div);
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT), parts = [];
    const number = Number(div.dataset.pageNumber) || viewer?.currentPageNumber;
    const view = viewer?.getPageView(number - 1);
    const spans = (view?._textHighlighter?.textDivs || [...layer.querySelectorAll('span[role="presentation"]')]).filter(span => span.textContent);
    const spanSet = new Set(spans);
    const pdf = viewer?.pdfDocument;
    const fontAt = locator.layerFonts(view, layer, () => {
      if (stopped || viewer?.pdfDocument !== pdf) return;
      clearLayer(div); queueWarm(number);
      if (!document.getSelection()?.isCollapsed) selectFromPdf();
      else if (contexts.length || reviewPointer) schedule();
    });
    const measurement = document.createRange(), elementFonts = new Map(), nodes = [];
    let raw = "", previous = null, previousElement = null, node;
    while ((node = walker.nextNode())) {
      // Keep OCR space spans; rendered glyph widths cannot reconstruct every word gap.
      if (!node.textContent || !node.textContent.trim() && node.parentElement === layer) continue;
      let element = node;
      while (element !== layer && !spanSet.has(element)) element = element.parentNode;
      if (element === layer) element = node.parentElement;
      measurement.selectNodeContents(node);
      const item = fontAt.items?.get(element);
      const box = item ? { bottom: -item.transform[5], height: item.height,
        left: item.transform[4], right: item.transform[4] + item.width } : measurement.getBoundingClientRect();
      nodes.push({ node, element, box });
    }
    for (const { node, element, box } of nodes.sort((a, b) =>
      Math.round((a.box.bottom - b.box.bottom) / Math.max(a.box.height, b.box.height)) || a.box.left - b.box.left)) {
      if (previous && element !== previousElement) {
        const lineBreak = Math.abs(box.bottom - previous.bottom) > Math.max(box.height, previous.height) * 0.5;
        if (lineBreak) raw += "\n";
        else if (box.left - previous.right > Math.max(box.height, previous.height) * 0.08) raw += " ";
      }
      if (!elementFonts.has(element)) elementFonts.set(element, fontAt?.(element));
      parts.push({ node, start: raw.length, end: raw.length + node.textContent.length, font: elementFonts.get(element) });
      raw += node.textContent; previous = box; previousElement = element;
    }
    const observer = new MutationObserver(records => {
      if (!clearLayer(div, records)) return;
      queueWarm(number);
      if (contexts.length || reviewPointer) schedule();
    });
    observer.observe(layer, { subtree: true, childList: true, characterData: true, attributes: true });
    const index = new PdfSourceIndex(locator, { layer, raw, parts, observer, pdf, width: div.clientWidth, height: div.clientHeight });
    layers.set(div, index);
    return index;
  }
  function findLocations(pdf, entries, visibleOnly = false) {
    const scope = window.ReaderUI?.getPdfSourcePages?.();
    const documentIndex = locator.getDocumentIndex(pdf, scope);
    const visible = locator.environment.getVisiblePages?.() || [], pageIndexes = visible.map(page => page.index);
    for (const source of new Set(entries.map(entry => entry.index).filter(Boolean)))
      source?.diff(pageIndexes, pdf);
    entries = entries.flatMap(entry => {
      if (!visibleOnly && !entry.marked) return [entry];
      const connections = entry.index?.connectionPairs([...pageIndexes, documentIndex]);
      if (!connections?.length || connections.some(([range]) => range.start <= entry.start && range.end >= entry.end)) return [entry];
      const ranges = [...connections.map(([range]) => range),
        ...entry.index.differences.items
          .filter(item => item.missing).map(item => ({ start: item.sourceStart, end: item.sourceEnd }))]
        .map(range => [Math.max(entry.start, range.start), Math.min(entry.end, range.end)]).filter(([start, end]) => end > start);
      return ranges.length ? ranges.map(([start, end]) => locator.sourceEntry(entry.index, start, end, entry.marked)) : [entry];
    });
    const locations = entries.map(entry => {
      let index = documentIndex, hit = null, number;
      for (const page of visible) {
        hit = page.index && entry.index && entry.index.connectedRange(page.index, entry.start, entry.end, false, undefined, true);
        if (!hit) continue;
        ({ index, number } = page);
        break;
      }
      if (!hit && index) hit = (entry.index && entry.index.connectedRange(index, entry.start, entry.end, false, undefined, true))
        || (!visibleOnly && index.locate(entry, entry.index && index.pageScopes.get(entry.index)?.scope));
      const missing = (!hit || entry.marked && entry.start === entry.end) && window.PdfReviewProvider?.textEnabled !== false && entry.index?.differences.items
        .find(item => item.missing && (entry.start === entry.end ? entry.marked && entry.start >= item.sourceStart && entry.start <= item.sourceEnd
          : entry.start < item.sourceEnd && entry.end > item.sourceStart));
      if (missing) {
        const source = { index: entry.index, start: entry.start < entry.end ? Math.max(entry.start, missing.sourceStart) : missing.sourceStart,
          end: entry.start < entry.end ? Math.min(entry.end, missing.sourceEnd) : missing.sourceEnd };
        const difference = { html: entry.index.raw.slice(source.start, source.end), pdf: '', missing: true };
        const targets = visible.flatMap(({ number, index }) => {
          const range = index?.raw.trim() && entry.index.missingRange(index, missing.sourceStart, missing.sourceEnd, entry.start, entry.end);
          return range && range.end > range.start ? [{ pageNumber: number, range,
            start: source.start, end: source.end, marked: true, text: '', source, difference }] : [];
        });
        return { entry, targets, notice: { ...difference, source } };
      }
      if (!hit) return { entry, targets: [], queries: entry.index ? [] : [entry.text] };
      const connection = hit.connection || (entry.index && entry.index.rememberConnection(entry.start, entry.end, index, hit));
      const counterpart = index.raw.slice(hit.start, hit.end);
      const difference = hit.approximate || entry.text !== counterpart ? { html: entry.text, pdf: counterpart } : null;
      const pages = index.pages || [{ number, start: 0, end: index.raw.length, parts: index.parts }];
      const targets = pages.filter(page => hit.start === hit.end ? hit.start >= page.start && hit.start <= page.end
        : hit.start < page.end && hit.end > page.start).map(page => {
        const start = Math.max(hit.start, page.start), end = Math.min(hit.end, page.end);
        const target = { pageNumber: page.number, item: page.parts.find(part => part.end > start)?.item,
          difference,
          marked: entry.marked, text: index.raw.slice(start, end), before: index.raw.slice(Math.max(page.start, start - 160), start),
          after: index.raw.slice(end, Math.min(page.end, end + 160)) };
        if (target.difference && entry.index) target.source = { index: entry.index, start: entry.start, end: entry.end };
        const sourceRange = entry.marked || entry.start === entry.end ? entry : entry.index && entry.index.connectedRange(index, start, end, true, connection);
        if (sourceRange || hit.start === hit.end) Object.assign(target, { index: entry.index,
          start: sourceRange?.start ?? entry.start, end: sourceRange?.end ?? entry.end });
        return target;
      });
      return { entry, targets, notice: entry.marked && difference && {
        ...difference, source: entry.index && { index: entry.index, start: entry.start, end: entry.end } } };
    });
    // Reader searches stay within the current file's corresponding PDF pages.
    if (visibleOnly || documentIndex || locations.every(location => location.targets.length)) return locations;
    return locator.indexDocument(pdf, scope).then(index => index ? findLocations(pdf, entries) : locations);
  }
  function locateSource(index, chunks) {
    const first = chunks[0], last = chunks.at(-1);
    index?.diff(chunks.map(chunk => chunk.index), viewer?.pdfDocument);
    const entry = {
      text: chunks.map(({ index, start, end }) => index.raw.slice(start, end)).join("\n"),
      before: first.index.raw.slice(Math.max(0, first.start - 160), first.start),
      after: last.index.raw.slice(last.end, last.end + 160)
    };
    let hit = chunks.length === 1 && index.connectedRange(first.index, first.start, first.end, true);
    if (!hit) {
      const left = index.pageScopes.get(first.index)?.scope, right = index.pageScopes.get(last.index)?.scope;
      const scope = left === right ? left : left && right && left.start <= right.start ? { start: left.start, end: right.end } : null;
      hit = index.locate(entry, scope);
    }
    const html = hit && index.raw.slice(hit.start, hit.end);
    const differs = hit && significantText(html, index, hit.start) !== significantText(entry.text);
    const difference = !hit ? { message: "No reliable HTML match" } : differs ? { html, pdf: entry.text } : null;
    if (chunks.length === 1 && hit && !hit.connection)
      index.rememberConnection(hit.start, hit.end, first.index, { start: first.start, end: first.end });
    if (difference && hit) locator.comparisonParts(difference);
    return { hit, difference };
  }
  function locateLayer(index, queries, targets = []) {
    const { raw } = index;
    const hits = new Map();
    const append = matches => {
      for (const hit of matches) {
        const key = `${hit.start}:${hit.end}`;
        if (!hits.has(key) || hit.difference?.missing) hits.set(key, hit);
      }
    };
    let focusHit = null;
    for (const target of targets) {
      const connection = target.index && target.index.connectedRange(index, target.start, target.end, false, undefined, true);
      const hit = target.range || connection || index.locate(target);
      if (hit) {
        if (target.index && !connection) target.index.rememberConnection(target.start, target.end, index, hit);
        hit.difference = target.difference || (hit.approximate ? { html: target.text, pdf: raw.slice(hit.start, hit.end) } : null);
        if (hit.difference) locator.comparisonParts(hit.difference);
        hit.source = target.source || target.index && { index: target.index, start: target.start, end: target.end };
        if (!focusHit) focusHit = hit;
      }
      // Unconfirmed default differences must not highlight unrelated occurrences.
      append(hit ? [hit] : target.marked || target.index ? [] : index.matches([target.text]));
    }
    append(index.matches(queries));
    return { hits: [...hits.values()], focusHit };
  }
  function nativeBoxes(div, queries, targets = []) {
    const index = layerIndex(div);
    if (!index) return { boxes: [], count: 0, pending: true };
    const key = JSON.stringify([queries, targets.map(target =>
      [target.text, target.before, target.after, target.difference, target.range, target.start, target.end, target.marked])]);
    const source = targets.find(target => target.source)?.source.index || contexts[0]?.index;
    let cached = pageResults.get(index);
    if (!cached || cached.source !== source) {
      cached = { source, results: new Map() };
      pageResults.set(index, cached);
    }
    if (cached.results.has(key)) return cached.results.get(key);
    const { hits, focusHit } = locateLayer(index, queries, targets);
    const result = review.measureHighlights(div, index, hits, focusHit);
    // Reuse the confirmed PDF item when its counterpart has no measurable text.
    if (!result.notices.length) result.notices = targets.filter(target => target.marked && target.source && target.difference).map(target => {
      const viewport = viewer.getPageView(target.pageNumber - 1)?.viewport, item = target.item;
      const point = item && viewport?.convertToViewportPoint(item.transform[4], item.transform[5]);
      return { ...target.difference, source: target.source, box: point && {
        x: point[0] / viewport.width, y: (point[1] - item.height * viewport.scale) / viewport.height,
        w: 0, h: item.height * viewport.scale / viewport.height } };
    });
    cached.results.set(key, result);
    if (cached.results.size > 32) cached.results.delete(cached.results.keys().next().value);
    return result;
  }
  function paint(div, boxes, notices = [], pointer = false) {
    const painted = review.paintHighlight(div, boxes, options.color, pointer);
    if (!pointer && notices.length) publishDifferences(div, painted, notices);
  }
  async function refreshReviewPointer() {
    const pointer = reviewPointer || defaultPointer;
    if (!pointer || contexts.length) { review.clearHighlights(true); return; }
    if (stopped || !currentPointer(pointer)) { api.clearReviewPointer(pointer.editor); return; }
    const found = findLocations(pointer.pdf, pointer.entries, !reviewPointer), locations = Array.isArray(found) ? found : await found;
    if (contexts.length || (reviewPointer || defaultPointer) !== pointer) return;
    if (!currentPointer(pointer)) { api.clearReviewPointer(pointer.editor); return; }
    const visible = new Set(), targets = locations.flatMap(location => location.targets);
    for (const number of visiblePages()) {
      const div = viewer.getPageView(number - 1)?.div;
      if (!div) continue;
      visible.add(div);
      const result = nativeBoxes(div, [], targets.filter(target => target.pageNumber === number));
      // Painting a marker must not publish selection events that could reopen
      // the popup on its previous side during a window switch; clicks publish it.
      // A text layer can be temporarily unavailable while PDF.js updates it.
      // Keep the last mapped pointer until its replacement can be measured.
      if (result.boxes.length) {
        review.paintHighlight(div, result.boxes, options.color, true).notices = result.notices;
        review.getHighlight(div, true)?.node.classList.toggle('mew-pdf-default-highlight', !reviewPointer);
        review.getHighlight(div, true)?.node.classList.toggle('mew-review-preview',
          pointer.editor.getDomNode()?.classList.contains('mew-review-preview') || false);
      }
    }
    review.clearHighlights(true, visible);
  }
  function publishDifferences(div, painted, notices, pointer = false) {
    // Publish mapping data only. The review adapter chooses where and how to show it.
    const editor = currentEditor(), model = editor?.getModel(), selected = selectionRevision;
    if (notices.length) setTimeout(function publish() {
      if ((!diffHighlight && !sourceDiffHighlight && !notices[0].missing) || !pointer && !selectionHighlight || stopped || selected !== selectionRevision || notifiedSelection === selected
        || div && !div.isConnected || painted && (!painted.node.isConnected || review.getHighlight(div, pointer) !== painted)) return;
      // Opening review selects its candidate; wait until the user's drag ends.
      if (selecting) { pendingDifference = publish; return; }
      notifiedSelection = selected;
      const box = notices[0].box, page = div?.getBoundingClientRect();
      const anchor = box && { left: page.left + box.x * page.width, top: page.top + box.y * page.height,
        bottom: page.top + (box.y + box.h) * page.height };
      window.dispatchEvent(new CustomEvent('pdf-selection-difference', { detail: {
        editor, model, pdf: viewer?.pdfDocument, notices, anchor, anchorElement: div, anchorBox: box, interactionId,
        targets: locator.environment.getTargets()
      } }));
    }, 0);
  }
  async function refresh(run) {
    if (!contexts.length || !viewer?.pdfDocument || stopped) return;
    const instance = viewer, pdf = instance.pdfDocument, results = [];
    const current = () => !stopped && run === revision && instance === viewer && pdf === viewer.pdfDocument;
    if (!locationSearch || locationSearch.pdf !== pdf) {
      report("searching", { error: null });
      const entries = contexts.slice();
      const found = findLocations(pdf, entries, entries.every(entry => entry.marked));
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
    publishSources();
    publishDifferences(null, null, locations?.flatMap(location => location.notice && !location.targets.length ? [location.notice] : []) || [], true);
    const exact = locations?.flatMap(location => location.targets) || [];
    const queries = locations?.flatMap(location => location.targets.length ? [] : location.queries || [location.entry.text]) || [];
    if (!positioned && exact.length) {
      await Promise.resolve();
      if (!current()) return;
      const target = exact[0], view = instance.getPageView(target.pageNumber - 1);
      const focus = view?.div && nativeBoxes(view.div, queries, exact.filter(entry => entry.pageNumber === target.pageNumber)).focus;
      if (focus) {
        positioned = true;
        const container = instance.container, rect = container.getBoundingClientRect(), box = view.div.getBoundingClientRect();
        const sx = rect.width / container.offsetWidth, sy = rect.height / container.offsetHeight;
        const left = box.left + (view.div.clientLeft + focus.x * view.div.clientWidth) * box.width / view.div.offsetWidth,
          top = box.top + (view.div.clientTop + focus.y * view.div.clientHeight) * box.height / view.div.offsetHeight;
        const vertical = top < rect.top + container.clientTop * sy || top + focus.h * box.height > rect.top + (container.clientTop + container.clientHeight) * sy;
        const horizontal = left < rect.left + container.clientLeft * sx || left + focus.w * box.width > rect.left + (container.clientLeft + container.clientWidth) * sx;
        if (vertical || horizontal) {
          // Revealing text near the page bottom must not expose mostly the next
          // page: PDF.js would report that page and switch the paired HTML file.
          const bottom = rect.top + (container.clientTop + container.clientHeight) * sy,
            right = rect.left + (container.clientLeft + container.clientWidth) * sx;
          container.scrollBy({
            top: vertical ? Math.min((top - rect.top) / sy - 48, Math.max(0, (box.bottom - bottom) / sy)) : 0,
            left: horizontal ? Math.min((left - rect.left) / sx - 24, Math.max(0, (box.right - right) / sx)) : 0
          });
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
    review.clearHighlights(false, visible);
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
