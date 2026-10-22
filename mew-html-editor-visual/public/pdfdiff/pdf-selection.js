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
  let reviewPointer = null;
  let viewer = null, revision = 0, timer, stopped = false, hooking = false, diffHighlight = true, selectionHighlight = true;
  let preferenceWrites = Promise.resolve(), selectionRevision = 0, notifiedSelection = -1, interactionId = 0;
  try {
    const response = await fetch('/api/reader/settings');
    if (response.ok) {
      const settings = await response.json();
      diffHighlight = settings.diffHighlight !== false;
      selectionHighlight = settings.selectionHighlight !== false;
    }
  } catch {}
  let visualDocument = null, detachVisual = () => {};
  let pairedWindow = null, pairedSession = "";
  const locator = new review.PdfLocator(options, {
    document, getPdf: () => viewer?.pdfDocument,
    getTargets: () => [...layers.values()].filter(page => page.pdf === viewer?.pdfDocument),
    getVisiblePages: () => visiblePages().map(number => ({ number, index: layerIndex(viewer.getPageView(number - 1)?.div) })),
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
    status, locator, attachEditor, attachViewer,
    highlight: text => select(Array.isArray(text) ? text : [text]),
    clear: () => select([]),
    popupPlacement(anchor, viewport, width, height) {
      const boxes = [];
      for (const number of visiblePages()) {
        const div = viewer.getPageView(number - 1)?.div;
        const painted = div ? [review.getHighlight(div), review.getHighlight(div, true)].filter(area => area?.node.isConnected) : [];
        if (!painted.length) continue;
        const page = div.getBoundingClientRect(), sx = page.width / div.offsetWidth, sy = page.height / div.offsetHeight;
        const pageLeft = page.left + div.clientLeft * sx, pageTop = page.top + div.clientTop * sy,
          pageWidth = div.clientWidth * sx, pageHeight = div.clientHeight * sy;
        for (const mark of painted.flatMap(area => area.boxes)) {
          const left = pageLeft + mark.x * pageWidth, top = pageTop + mark.y * pageHeight;
          const box = { left, top, right: left + mark.w * pageWidth,
            bottom: top + mark.h * pageHeight, height: mark.h * pageHeight };
          if (!box.height || box.bottom <= viewport.top || box.top >= viewport.bottom) continue;
          const previous = boxes.at(-1);
          // Gaps narrower than the popup cannot hold it; treat adjoining words as one obstacle.
          if (previous && Math.abs(previous.top - box.top) < .5 && Math.abs(previous.bottom - box.bottom) < .5
            && box.left <= previous.right + width && box.right >= previous.left - width) {
            previous.left = Math.min(previous.left, box.left); previous.right = Math.max(previous.right, box.right);
          } else boxes.push({ left: box.left, right: box.right, top: box.top, bottom: box.bottom });
        }
      }
      // A multiline anchor spans the gaps too; use the actual marks when painted.
      if (!boxes.length) boxes.push({ ...anchor, right: anchor.right ?? anchor.left + 2 });
      const candidates = [];
      for (const box of boxes) {
        const left = Math.max(viewport.left, Math.min(viewport.right - width, box.left));
        const obstacles = boxes.filter(other => other.left < left + width && other.right > left);
        for (const above of [true, false]) {
          const edge = above ? box.top - 8 : box.bottom + 8;
          if (edge < viewport.top || edge > viewport.bottom) continue;
          // Find the free vertical interval directly adjoining this highlight.
          let start = above ? viewport.top : edge, end = above ? edge : viewport.bottom;
          for (const other of obstacles) {
            if (above && other.top < edge) start = Math.max(start, other.bottom + 8);
            if (!above && other.bottom > edge) end = Math.min(end, other.top - 8);
          }
          const available = Math.min(height, end - start);
          if (available < 40) continue;
          const top = above ? end - available : start;
          candidates.push({ left, top, height: available,
            distance: Math.abs((above ? end : start) - (above ? anchor.top : anchor.bottom)) });
        }
      }
      // Prefer a complete popup, then the closest highlight; shrink only if necessary.
      candidates.sort((a, b) => b.height - a.height || a.distance - b.distance);
      return candidates[0] || null;
    },
    showReviewPointer(editor, items) {
      api.clearReviewPointer();
      const model = editor?.getModel();
      if (!model || !items?.length || !diffHighlight) return;
      const index = locator.editorSourceIndex(model), entries = items.map(({ sourceStart: start, sourceEnd: end }) => ({
        index, start, end, marked: true, text: index.raw.slice(start, end),
        before: index.raw.slice(Math.max(0, start - 160), start), after: index.raw.slice(end, end + 160) }));
      reviewPointer = { editor, model, version: model.getVersionId?.(), pdf: viewer?.pdfDocument, entries };
      schedule();
    },
    clearReviewPointer(editor) {
      if (!reviewPointer || editor && reviewPointer.editor !== editor) return;
      review.clearHighlights(true);
      reviewPointer = null;
    },
    setDiffHighlight(enabled) {
      diffHighlight = !!enabled;
      api.clearReviewPointer();
      savePreference('diffHighlight', diffHighlight, '无法保存差异高亮设置');
      publishSources();
      if (diffHighlight) queueWarm();
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
    get enabled() { return diffHighlight; },
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
  function clearOverlays() { review.clearHighlights(); }
  function clearLayers() { for (const div of layers.keys()) clearLayer(div); }
  function clearLayer(div) { layers.get(div)?.observer.disconnect(); layers.delete(div); pageResults.delete(div); }
  function resetPdf() {
    api.clearReviewPointer();
    ++revision;
    clearTimeout(timer);
    clearOverlays();
    clearLayers();
    window.dispatchEvent(new CustomEvent('pdf-selection-reset'));
  }
  function select(texts, surroundings = [], plain = false) {
    if (!selectionHighlight && texts.length) return;
    ++selectionRevision;
    lastInteraction = performance.now();
    const decode = text => (plain ? String(text || "") : locator.sourceIndex(String(text || "")).raw).trim();
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
      if (syncingPdf || !selectionHighlight) return;
      if (event?.changes || readTimer !== null) {
        lastEdit = performance.now();
        if (readTimer === null) select([]);
        clearTimeout(readTimer);
        readTimer = setTimeout(() => { readTimer = null; read(); }, editIdleDelay);
        return;
      }
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
      if (viewer && index.preparedPdf !== viewer.pdfDocument) queueWarm();
      const entries = ranges.map(range => {
        const start = model.getOffsetAt(range.getStartPosition()), end = model.getOffsetAt(range.getEndPosition());
        const { start: a, end: b } = index.rawRange(start, end);
        return { index, marked, start: a, text: end > start ? index.raw.slice(a, b) : "",
          before: index.raw.slice(Math.max(0, a - 160), a), after: index.raw.slice(b, b + 160) };
      });
      select(entries.map(entry => entry.text), entries, true);

    };
    for (const name of ["onDidChangeCursorSelection", "onDidChangeModel", "onDidChangeModelContent"]) {
      const subscription = editor[name]?.(read);
      if (subscription) cleanup.push(() => subscription.dispose());
    }
    const click = editor.onMouseUp?.(event => {
      if (event.target?.position && event.target.type !== 9) {
        ++interactionId;
        read({ position: event.target.position, lineRange: event.target.type === 4 ? event.target.range : null });
      }
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
    listen(instance.container, 'pointerdown', () => { ++interactionId; }, { passive: true });
    listen(instance.container, "keydown", event => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) manualScroll();
    });
    for (const event of ["pagesinit", "pagechanging", "pagerendered", "textlayerrendered", "scalechanging", "rotationchanging", "updateviewarea"]) {
      const update = data => {
        if (viewer !== instance) return;
        if (event === "textlayerrendered") clearLayer(instance.getPageView(data?.pageNumber - 1)?.div);
        if (["pagesinit", "scalechanging", "rotationchanging"].includes(event)) { clearLayers(); clearOverlays(); }
        if (event !== "updateviewarea" && event !== "pagechanging") queueWarm(data?.pageNumber);
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
    if (stopped || (!diffHighlight && !selectionHighlight)) return;
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
    }, 100);
  }
  function warm(numbers = visiblePages()) {
    const pdf = viewer?.pdfDocument, model = activeEditor?.getModel(), source = model && locator.editorSourceIndex(model);
    if (pdf && !locator.getDocumentIndex(pdf)) void locator.indexDocument(pdf).catch(() => {});
    for (const div of layers.keys()) if (!div.isConnected) clearLayer(div);
    const pages = numbers.map(number => layerIndex(viewer.getPageView(number - 1)?.div));
    locator.prepareSource(source, pages, pdf);
    publishSources();
  }
  function publishSources() {
    if (performance.now() - lastEdit < editIdleDelay) return;
    const pdf = viewer?.pdfDocument;
    const targets = [...layers.values()].filter(page => page.pdf === pdf);
    const full = locator.getDocumentIndex(pdf);
    if (full) targets.push(full);
    window.dispatchEvent(new CustomEvent('pdf-selection-sources', { detail: {
      editor: activeEditor, pdf, targets, enabled: diffHighlight,
      index: activeEditor?.getModel() && locator.editorSourceIndex(activeEditor.getModel())
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
    listen(doc, 'pointerdown', event => { if (event.button === 0) selecting = true; }, true);
    const release = () => {
      selecting = false;
      const publish = pendingDifference;
      pendingDifference = null;
      if (publish) setTimeout(publish, 0);
    };
    listen(doc, 'pointerup', release, true);
    listen(doc, 'pointercancel', release, true);
    listen(doc.defaultView, 'blur', release);
  }
  function selectFromPdf() {
    if (stopped || syncingPdf || !selectionHighlight || !viewer) return;
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
    const number = Number(div.dataset.pageNumber) || viewer?.currentPageNumber;
    const view = viewer?.getPageView(number - 1);
    const spans = (view?._textHighlighter?.textDivs || [...layer.querySelectorAll('span[role="presentation"]')]).filter(span => span.textContent);
    const spanSet = new Set(spans);
    const pdf = viewer?.pdfDocument;
    const fontAt = review.layerFonts(view, layer, () => {
      if (stopped || viewer?.pdfDocument !== pdf) return;
      clearLayer(div); queueWarm(number);
      if (!document.getSelection()?.isCollapsed) selectFromPdf();
      else if (contexts.length || reviewPointer) schedule();
    });
    const measurement = document.createRange(), elementFonts = new Map(), nodes = [];
    let raw = "", previous = null, previousElement = null, node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim()) continue;
      let element = node;
      while (element !== layer && !spanSet.has(element)) element = element.parentNode;
      if (element === layer) element = node.parentElement;
      measurement.selectNodeContents(node);
      const box = measurement.getBoundingClientRect();
      nodes.push({ node, element, box });
    }
    for (const { node, element, box } of nodes.sort((a, b) =>
      Math.round((a.box.top - b.box.top) / Math.max(a.box.height, b.box.height)) || a.box.left - b.box.left)) {
      if (previous && element !== previousElement) {
        const lineBreak = Math.abs(box.top - previous.top) > Math.min(box.height, previous.height) * 0.5;
        if (lineBreak) raw += "\n";
        else if (box.left - previous.right > Math.min(box.height, previous.height) * 0.08) raw += " ";
      }
      if (!elementFonts.has(element)) elementFonts.set(element, fontAt?.(element));
      parts.push({ node, start: raw.length, end: raw.length + node.textContent.length, font: elementFonts.get(element) });
      raw += node.textContent; previous = box; previousElement = element;
    }
    const observer = new MutationObserver(() => {
      clearLayer(div);
      queueWarm(number);
      if (contexts.length || reviewPointer) schedule();
    });
    observer.observe(layer, { subtree: true, childList: true, characterData: true, attributes: true });
    const index = new review.PdfSourceIndex(locator, { layer, raw, parts, observer, pdf, width: div.clientWidth, height: div.clientHeight });
    layers.set(div, index);
    return index;
  }
  function findLocations(pdf, entries) {
    const documentIndex = locator.getDocumentIndex(pdf);
    const visible = visiblePages().map(number => ({ number, index: layerIndex(viewer.getPageView(number - 1)?.div) }));
    for (const source of new Set(entries.map(entry => entry.index).filter(Boolean)))
      locator.prepareSource(source, visible.map(page => page.index), pdf);
    const locations = entries.map(entry => {
      let index = documentIndex, hit = null, number;
      for (const page of visible) {
        hit = page.index && entry.index && entry.index.connectedRange(page.index, entry.start, entry.end, false, undefined, entry.marked);
        if (hit) {
          index = page.index;
          number = page.number;
          break;
        }
      }
      if (!hit && index) hit = (entry.index && entry.index.connectedRange(index, entry.start, entry.end, false, undefined, entry.marked)) || index.locate(entry);
      if (!hit) return { entry, targets: [], queries: index && entry.index ? entry.index.patchedWords(entry.text, index) : [entry.text] };
      const connection = hit.connection || (entry.index && entry.index.rememberConnection(entry.start, entry.end, index, hit));
      const pages = index.pages || [{ number, start: 0, end: index.raw.length, parts: index.parts }];
      const targets = pages.filter(page => hit.start === hit.end ? hit.start >= page.start && hit.start <= page.end
        : hit.start < page.end && hit.end > page.start).map(page => {
        const start = Math.max(hit.start, page.start), end = Math.min(hit.end, page.end);
        const target = { pageNumber: page.number, item: page.parts.find(part => part.end > start)?.item,
          difference: hit.approximate || entry.marked && entry.text !== index.raw.slice(hit.start, hit.end)
            ? { html: entry.text, pdf: index.raw.slice(hit.start, hit.end) } : null,
          marked: entry.marked, text: index.raw.slice(start, end), before: index.raw.slice(Math.max(page.start, start - 160), start),
          after: index.raw.slice(end, Math.min(page.end, end + 160)) };
        if (target.difference && entry.index) target.source = { index: entry.index, start: entry.start, end: entry.end };
        const sourceRange = entry.marked || entry.start === entry.end ? entry : connection && entry.index.connectedRange(index, start, end, true, connection);
        if (sourceRange || hit.start === hit.end) Object.assign(target, { index: entry.index,
          start: sourceRange?.start ?? entry.start, end: sourceRange?.end ?? entry.end });
        return target;
      });
      return { entry, targets };
    });
    if (documentIndex || locations.every(location => location.targets.length)) return locations;
    return locator.indexDocument(pdf).then(index => index ? findLocations(pdf, entries) : locations);
  }
  function locateSource(index, chunks) {
    const first = chunks[0], last = chunks.at(-1);
    locator.prepareSource(index, chunks.map(chunk => chunk.index), viewer?.pdfDocument);
    const entry = {
      text: chunks.map(({ index, start, end }) => index.raw.slice(start, end)).join("\n"),
      before: first.index.raw.slice(Math.max(0, first.start - 160), first.start),
      after: last.index.raw.slice(last.end, last.end + 160)
    };
    const left = index.sourcePageScope(first.index, true), right = index.sourcePageScope(last.index, true);
    let hit = chunks.length === 1 && index.connectedRange(first.index, first.start, first.end, true);
    if (!hit) {
      const scope = left && right && left.start <= right.start ? { start: left.start, end: right.end } : null;
      hit = index.locate(entry, scope && { ...scope, normalized: left === right ? left.normalized : undefined });
    }
    const html = hit && index.raw.slice(hit.start, hit.end);
    const differs = hit && (hit.connection ? hit.approximate
      : window.PdfSelectionDiff.significantText(html) !== window.PdfSelectionDiff.significantText(entry.text));
    const difference = !hit ? { message: "No reliable HTML match" } : differs ? { html, pdf: entry.text } : null;
    if (chunks.length === 1 && hit && !hit.connection)
      index.rememberConnection(hit.start, hit.end, first.index, { start: first.start, end: first.end });
    return { hit, difference };
  }
  function locateLayer(index, queries, targets = []) {
    const { raw } = index;
    const hits = [];
    let focusHit = null;
    for (const target of targets) {
      const connection = target.index && target.index.connectedRange(index, target.start, target.end, false, undefined, target.marked);
      const hit = target.range || connection || index.locate(target);
      if (hit) {
        if (target.index && !connection) target.index.rememberConnection(target.start, target.end, index, hit);
        hit.difference = target.difference || (hit.approximate ? { html: target.text, pdf: raw.slice(hit.start, hit.end) } : null);
        hit.source = target.source || target.index && { index: target.index, start: target.start, end: target.end };
        if (!focusHit) focusHit = hit;
      }
      // Retain exact fallback highlights when rendered spacing prevents confirmation.
      for (const match of hit ? [hit] : index.matches(target.index ? target.index.patchedWords(target.text, index) : [target.text]))
        if (!hits.some(other => other.start === match.start && other.end === match.end)) hits.push(match);
    }
    for (const match of index.matches(queries))
      if (!hits.some(hit => hit.start === match.start && hit.end === match.end)) hits.push(match);
    return { hits, focusHit };
  }
  function nativeBoxes(div, queries, targets = []) {
    const index = layerIndex(div);
    if (!index) return { boxes: [], count: 0, pending: true };
    const key = JSON.stringify([queries, targets.map(target =>
      [target.text, target.before, target.after, target.difference, target.range, target.start, target.end, target.marked])]);
    let cached = pageResults.get(div);
    if (cached?.index !== index || cached.source !== contexts[0]?.index) {
      cached = { index, source: contexts[0]?.index, results: new Map() };
      pageResults.set(div, cached);
    }
    if (cached.results.has(key)) return cached.results.get(key);
    const { hits, focusHit } = locateLayer(index, queries, targets);
    const result = review.measureHighlights(div, index, hits, focusHit);
    cached.results.set(key, result);
    if (cached.results.size > 32) cached.results.delete(cached.results.keys().next().value);
    return result;
  }
  function paint(div, boxes, notices = [], pointer = false) {
    const painted = review.paintHighlight(div, boxes, options.color, pointer);
    if (!pointer && painted) publishDifferences(div, painted, notices);
  }
  async function refreshReviewPointer() {
    const pointer = reviewPointer;
    if (!pointer) return;
    if (stopped || pointer.pdf !== viewer?.pdfDocument || pointer.model !== pointer.editor.getModel()
      || pointer.version !== pointer.model.getVersionId?.()) { api.clearReviewPointer(pointer.editor); return; }
    const locations = await findLocations(pointer.pdf, pointer.entries);
    if (reviewPointer !== pointer) return;
    if (pointer.pdf !== viewer?.pdfDocument || pointer.model !== pointer.editor.getModel()
      || pointer.version !== pointer.model.getVersionId?.()) { api.clearReviewPointer(pointer.editor); return; }
    const visible = new Set();
    for (const number of visiblePages()) {
      const div = viewer.getPageView(number - 1)?.div;
      if (!div) continue;
      visible.add(div);
      const targets = locations.flatMap(location => location.targets).filter(target => target.pageNumber === number);
      const result = nativeBoxes(div, [], targets);
      // This is a PDF-only review marker. Never publish selection events that
      // could reopen the popup on its previous side during a window switch.
      // A text layer can be temporarily unavailable while PDF.js updates it.
      // Keep the last mapped pointer until its replacement can be measured.
      if (result.boxes.length) paint(div, result.boxes, [], true);
    }
    review.clearHighlights(true, visible);
  }
  function publishDifferences(div, painted, notices) {
    // Publish mapping data only. The review adapter chooses where and how to show it.
    const editor = activeEditor, model = editor?.getModel(), selected = selectionRevision;
    if (notices.length) setTimeout(function publish() {
      if (!diffHighlight || !selectionHighlight || stopped || selected !== selectionRevision || notifiedSelection === selected
        || !painted.node.isConnected || review.getHighlight(div) !== painted) return;
      // Opening review selects its candidate; wait until the user's drag ends.
      if (selecting) { pendingDifference = publish; return; }
      notifiedSelection = selected;
      const box = notices[0].box, page = div.getBoundingClientRect();
      const anchor = { left: page.left + box.x * page.width, top: page.top + box.y * page.height,
        bottom: page.top + (box.y + box.h) * page.height };
      window.dispatchEvent(new CustomEvent('pdf-selection-difference', { detail: {
        editor, model, pdf: viewer?.pdfDocument, notices, anchor, anchorElement: div, anchorBox: box, interactionId,
        targets: [locator.getDocumentIndex(viewer?.pdfDocument), ...layers.values()].filter(Boolean)
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
      const found = findLocations(pdf, entries);
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
          // Revealing text near the page bottom must not expose mostly the next
          // page: PDF.js would report that page and switch the paired HTML file.
          const bottom = rect.top + container.clientTop + container.clientHeight,
            right = rect.left + container.clientLeft + container.clientWidth;
          container.scrollBy({
            top: vertical ? Math.min(top - rect.top - 48, Math.max(0, box.bottom - bottom)) : 0,
            left: horizontal ? Math.min(left - rect.left - 24, Math.max(0, box.right - right)) : 0
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
