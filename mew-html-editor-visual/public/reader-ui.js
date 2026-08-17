(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const root = document.documentElement;
  const body = document.body;
  const grid = document.querySelector(".reader-grid");
  const scanPane = document.querySelector(".scan-pane");
  const sourceEditor = byId("editor");
  const visualFrame = byId("visualEditor");
  const scanStage = byId("scanStage");
  const listeners = {};
  let initialized = false;
  let statusTimer = null;
  let horizontalPages = false;
  let imageInverted = false;
  let pdfRuntimePromise = null;
  let pdfViewer = null;
  let pdfLinkService = null;
  let pdfLoadingTask = null;
  let pdfUrl = "";
  let pdfPageLabels = null;
  let pendingPdfLabel = "1";
  let pendingPdfPageNumber = null;
  let pdfRevision = 0;
  let scrollMode = null;
  const PDF_SCALE_KEY = "readerPdfScaleValue";

  function emit(name, ...args) {
    return listeners[name]?.(...args);
  }

  function bind(id, event, handler) {
    byId(id)?.addEventListener(event, handler);
  }

  function setToc(open) {
    root.classList.toggle("toc-open", open);
    byId("tocBtn")?.setAttribute("aria-expanded", String(open));
  }

  function setTheme(dark) {
    body.classList.toggle("dark", dark);
    localStorage.setItem("readerDark", dark ? "1" : "0");
    const button = byId("darkBtn");
    if (button) button.textContent = dark ? "浅色" : "深色";
    applyVisualTheme();
  }

  function applyVisualTheme() {
    const doc = visualFrame?.contentDocument;
    if (!doc?.body) return;
    const dark = body.classList.contains("dark");
    doc.documentElement.style.colorScheme = dark ? "dark" : "light";
    doc.documentElement.style.setProperty("--reader-bg", dark ? "#1e1e1e" : "#ffffff");
    doc.documentElement.style.setProperty("--reader-ink", dark ? "#d4d4d4" : "#251f1b");
    doc.documentElement.style.setProperty("--reader-link", dark ? "#4fc1ff" : "#8f2923");
  }

  function setMode(mode) {
    const sourceMode = mode === "source";
    byId("sourcePane").hidden = !sourceMode;
    visualFrame.hidden = sourceMode;
    const modeButton = byId("modeBtn");
    modeButton.textContent = sourceMode ? "可视化" : "源代码";
    modeButton.setAttribute("aria-pressed", String(sourceMode));
    modeButton.title = sourceMode ? "切换到可视化编辑" : "切换到源代码编辑";
    window.dispatchEvent(new Event("reader-mode-change"));
  }

  function notify(message, persistent = false) {
    byId("status").textContent = message || "";
    clearTimeout(statusTimer);
    if (message && !persistent) statusTimer = setTimeout(() => { byId("status").textContent = ""; }, 2600);
  }

  function setDirty(dirty, positionText) {
    byId("saveBtn").classList.toggle("dirty", dirty);
    byId("saveBtn").textContent = dirty ? "保存*" : "保存";
    byId("prevBtn").title = dirty ? "Alt+← & 保存" : "Alt+←";
    byId("nextPageBtn").title = dirty ? "Alt+→ & 保存" : "Alt+→";
    if (positionText != null) byId("pagePosition").textContent = positionText;
  }

  function setHistoryButtons(canUndo, canRedo) {
    byId("undoBtn").disabled = !canUndo;
    byId("redoBtn").disabled = !canRedo;
  }

  function renderVolumes(volumes, selected) {
    const select = byId("volumeSelect");
    select.replaceChildren(...volumes.map((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.shortTitle;
      return option;
    }));
    select.value = selected || "";
  }

  function renderToc(title, items) {
    byId("tocTitle").textContent = `${title}目录`;
    const list = byId("tocList");
    list.replaceChildren(...items.map((item) => {
      const li = document.createElement("li");
      li.style.setProperty("--level", item.level);
      const link = document.createElement("a");
      link.href = "#";
      link.dataset.page = item.page;
      const page = document.createElement("span");
      page.textContent = item.page;
      link.append(page, item.title);
      li.append(link);
      return li;
    }));
    byId("tocBtn").hidden = !items.length;
  }

  function renderNavigation(view) {
    byId("chapterTitle").textContent = view.chapterTitle;
    byId("pageContext").textContent = view.pageContext;
    byId("pagePosition").textContent = view.pagePosition;
    byId("pageInput").value = view.page;
    byId("volumeSelect").value = view.volume;
    byId("prevBtn").disabled = !view.hasPrevious;
    byId("nextPageBtn").disabled = !view.hasNext;
    byId("saveBtn").disabled = !view.editable;
    document.querySelectorAll("#tocList a").forEach((link) =>
      link.classList.toggle("active", Number(link.dataset.page) === view.chapterPage));
  }

  function renderTools(tags, attrs) {
    const bar = byId("tagBar");
    bar.replaceChildren(
      ...tags.map((tag, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.tag = index;
        button.textContent = tag.label;
        button.title = tag.hotkey ? `Alt+${tag.hotkey === "Enter" ? "Enter" : tag.hotkey.toUpperCase()}` : tag.title || tag.label;
        return button;
      }),
      ...attrs.map((attr, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.attr = index;
        button.textContent = attr.label;
        return button;
      })
    );
  }

  function findOptions() {
    return {
      query: byId("findText").value,
      replacement: byId("replaceText").value,
      regex: byId("regexBox").checked,
      caseSensitive: byId("caseBox").checked
    };
  }

  function updateHighlight(html) {
    const highlight = byId("highlight");
    highlight.innerHTML = html;
    highlight.scrollTop = sourceEditor.scrollTop;
    highlight.scrollLeft = sourceEditor.scrollLeft;
  }

  function scrollSourceSelectionIntoView(position) {
    const wrap = sourceEditor.parentElement;
    const style = getComputedStyle(sourceEditor);
    const mirror = document.createElement("div");
    const marker = document.createElement("span");
    mirror.style.cssText = `position:absolute;visibility:hidden;inset:0 auto auto 0;width:${sourceEditor.clientWidth}px;min-height:${sourceEditor.clientHeight}px;padding:${style.padding};border:0;margin:0;box-sizing:border-box;overflow-wrap:break-word;white-space:pre-wrap;font:${style.font};line-height:${style.lineHeight};letter-spacing:${style.letterSpacing};tab-size:${style.tabSize}`;
    mirror.textContent = sourceEditor.value.slice(0, position);
    marker.textContent = "\u200b";
    mirror.append(marker);
    wrap.append(mirror);
    sourceEditor.scrollTop = Math.max(0, marker.offsetTop - sourceEditor.clientHeight / 2);
    sourceEditor.scrollLeft = Math.max(0, marker.offsetLeft - sourceEditor.clientWidth / 2);
    mirror.remove();
    emit("sourceScroll");
  }

  function showVisual(source, options) {
    visualFrame.onload = () => {
      const doc = visualFrame.contentDocument;
      if (!doc?.body) return;
      doc.body.contentEditable = options.editable ? "true" : "false";
      doc.body.spellcheck = false;
      doc.body.addEventListener("beforeinput", () => emit("beforeEdit"));
      doc.body.addEventListener("input", () => emit("visualInput"));
      doc.addEventListener("dblclick", () => emit("visualDoubleClick", doc));
      doc.addEventListener("keydown", (event) => emit("keyDown", event));
      doc.addEventListener("click", (event) => emit("visualClick", event, doc));
      const updateLinkMode = (event) => doc.documentElement.classList.toggle("reader-ctrl-link", event.ctrlKey || event.metaKey);
      doc.addEventListener("keydown", updateLinkMode);
      doc.addEventListener("keyup", updateLinkMode);
      doc.addEventListener("mousemove", updateLinkMode);
      visualFrame.contentWindow.addEventListener("blur", () => doc.documentElement.classList.remove("reader-ctrl-link"));
      applyVisualTheme();
      if (options.scroll) requestAnimationFrame(() => {
        doc.scrollingElement.scrollTop = options.scroll.top;
        doc.scrollingElement.scrollLeft = options.scroll.left;
      });
    };
    visualFrame.srcdoc = source;
  }

  function updatePdfDirection() {
    const button = byId("pdfDirection");
    button.setAttribute("aria-pressed", String(horizontalPages));
    button.textContent = horizontalPages ? "上下翻页" : "左右翻页";
    button.title = horizontalPages ? "改为上下连续翻页" : "改为左右连续翻页";
    if (pdfViewer && scrollMode) {
      pdfViewer.scrollMode = horizontalPages ? scrollMode.HORIZONTAL : scrollMode.VERTICAL;
    }
    localStorage.setItem("readerPdfHorizontal", horizontalPages ? "1" : "0");
  }

  function updatePdfScale(scale, presetValue = "") {
    if (!Number.isFinite(scale)) return;
    const percent = Number((scale * 100).toFixed(1));
    const button = byId("zoomFit");
    button.textContent = `${percent}%`;
    button.title = `PDF.js 当前缩放 ${percent}%；点击适合页宽（此比例会自动记忆）`;
    button.setAttribute("aria-label", button.title);
    localStorage.setItem(PDF_SCALE_KEY, presetValue || String(scale));
  }

  function setPdfStatus(message = "") {
    const missing = byId("scanMissing");
    missing.hidden = !message;
    if (message) missing.textContent = message;
    byId("fullImage").disabled = Boolean(message);
  }

  function pdfPageNumberForLabel(label) {
    if (!pdfPageLabels?.length) return null;
    const wanted = String(label);
    const matches = [];
    for (let index = 0; index < pdfPageLabels.length; index += 1) {
      if (String(pdfPageLabels[index]) === wanted) matches.push(index + 1);
    }
    if (!matches.length) return null;
    const current = pdfViewer?.currentPageNumber || matches[0];
    return matches.reduce((best, page) =>
      Math.abs(page - current) < Math.abs(best - current) ? page : best
    );
  }

  function showPendingPdfPage() {
    if (!pdfViewer?.pdfDocument) return;
    const pageNumber = Number.isInteger(pendingPdfPageNumber)
      ? pendingPdfPageNumber
      : pdfPageNumberForLabel(pendingPdfLabel);
    if (pageNumber == null) {
      notify(`PDF 中找不到页面标签“${pendingPdfLabel}”`, true);
      return;
    }
    pdfViewer.currentPageNumber = pageNumber;
  }

  function setImageInverted(inverted) {
    imageInverted = Boolean(inverted);
    body.classList.toggle("image-inverted", imageInverted);
    const button = byId("imageInvert");
    button?.setAttribute("aria-pressed", String(imageInverted));
    if (button) {
      button.textContent = imageInverted ? "还原" : "反色";
      button.title = imageInverted ? "恢复 PDF 页面的原始颜色，并记住此设置" : "反转 PDF 页面颜色，并记住此设置";
    }
    localStorage.setItem("readerImageInverted", imageInverted ? "1" : "0");
  }

  async function ensurePdfRuntime() {
    if (pdfRuntimePromise) return pdfRuntimePromise;
    pdfRuntimePromise = (async () => {
      const pdfjs = await import("/vendor/pdfjs/build/pdf.mjs");
      // pdf_viewer.mjs reads the display-layer API from this global while the
      // module is evaluated, so its import must happen after registration.
      globalThis.pdfjsLib = pdfjs;
      const viewer = await import("/vendor/pdfjs/web/pdf_viewer.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.mjs";
      const eventBus = new viewer.EventBus();
      pdfLinkService = new viewer.PDFLinkService({ eventBus });
      pdfViewer = new viewer.PDFViewer({
        container: scanStage,
        viewer: byId("pdfViewer"),
        eventBus,
        linkService: pdfLinkService,
        imageResourcesPath: "/vendor/pdfjs/web/images/"
      });
      pdfLinkService.setViewer(pdfViewer);
      scrollMode = viewer.ScrollMode;
      eventBus.on("pagesinit", () => {
        const savedScale = localStorage.getItem(PDF_SCALE_KEY) || "page-width";
        pdfViewer.setPageLabels(pdfPageLabels);
        pdfViewer.currentScaleValue = savedScale;
        updatePdfDirection();
        showPendingPdfPage();
        setPdfStatus();
      });
      eventBus.on("pagechanging", ({ pageNumber, pageLabel }) => {
        if (pageNumber != null) emit("pdfPageChange", { pageNumber, pageLabel });
      });
      eventBus.on("scalechanging", ({ scale, presetValue }) => updatePdfScale(scale, presetValue));
      return pdfjs;
    })();
    return pdfRuntimePromise;
  }

  async function setPdf({ url, pageLabel, pageNumber = null }) {
    pendingPdfLabel = String(pageLabel ?? "1");
    pendingPdfPageNumber = Number.isInteger(pageNumber) ? pageNumber : null;
    const revision = ++pdfRevision;
    const pdfjs = await ensurePdfRuntime();
    if (revision !== pdfRevision) return;
    if (url === pdfUrl && (pdfViewer.pdfDocument || pdfLoadingTask)) {
      showPendingPdfPage();
      return;
    }
    pdfUrl = url || "";
    setPdfStatus(url ? "正在载入 PDF…" : "此卷未配置 PDF");
    pdfViewer.setDocument(null);
    pdfLinkService.setDocument(null);
    pdfPageLabels = null;
    await pdfLoadingTask?.destroy();
    pdfLoadingTask = null;
    if (!url || revision !== pdfRevision) return;
    try {
      pdfLoadingTask = pdfjs.getDocument({
        url,
        cMapUrl: "/vendor/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
        wasmUrl: "/vendor/pdfjs/wasm/"
      });
      const document = await pdfLoadingTask.promise;
      if (revision !== pdfRevision) return document.destroy();
      pdfPageLabels = await document.getPageLabels()
        || Array.from({ length: document.numPages }, (_, index) => String(index + 1));
      if (revision !== pdfRevision) return document.destroy();
      pdfViewer.setDocument(document);
      pdfLinkService.setDocument(document);
    } catch (error) {
      if (revision !== pdfRevision) return;
      pdfLoadingTask = null;
      setPdfStatus(`PDF 载入失败：${error.message}`);
      notify(`PDF 载入失败：${error.message}`, true);
    }
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement === scanPane) await document.exitFullscreen();
    else await scanPane.requestFullscreen();
  }

  function init(handlers) {
    Object.assign(listeners, handlers);
    if (initialized) return;
    initialized = true;
    bind("modeBtn", "click", () => emit("mode"));
    bind("saveBtn", "click", () => emit("save"));
    bind("undoBtn", "click", () => emit("undo"));
    bind("redoBtn", "click", () => emit("redo"));
    bind("volumeSelect", "change", (event) => emit("volume", event.target.value));
    bind("pageForm", "submit", (event) => { event.preventDefault(); emit("page", Number(byId("pageInput").value)); });
    bind("prevBtn", "click", () => emit("adjacent", -1));
    bind("nextPageBtn", "click", () => emit("adjacent", 1));
    bind("tocBtn", "click", () => setToc(!root.classList.contains("toc-open")));
    bind("tocClose", "click", () => setToc(false));
    bind("tocBackdrop", "click", () => setToc(false));
    bind("tocList", "click", (event) => {
      const link = event.target.closest("[data-page]");
      if (!link) return;
      event.preventDefault();
      setToc(false);
      emit("page", Number(link.dataset.page));
    });
    bind("darkBtn", "click", () => setTheme(!body.classList.contains("dark")));
    bind("tagBar", "click", (event) => {
      const tag = event.target.closest("[data-tag]");
      const attr = event.target.closest("[data-attr]");
      if (tag) emit("tag", Number(tag.dataset.tag));
      if (attr) emit("attr", Number(attr.dataset.attr));
    });
    sourceEditor.addEventListener("beforeinput", () => emit("beforeEdit"));
    sourceEditor.addEventListener("input", () => emit("sourceInput"));
    sourceEditor.addEventListener("scroll", () => emit("sourceScroll"));
    sourceEditor.addEventListener("dblclick", () => emit("sourceDoubleClick"));
    byId("highlight").addEventListener("click", (event) => emit("highlightClick", event));
    bind("findBtn", "click", () => emit("find"));
    bind("nextBtn", "click", () => emit("nextMatch"));
    bind("replaceBtn", "click", () => emit("replace"));
    bind("allBtn", "click", () => emit("replaceAll"));
    ["findText", "regexBox", "caseBox"].forEach((id) => bind(id, id === "findText" ? "input" : "change", () => emit("findChanged")));
    bind("zoomIn", "click", () => pdfViewer?.increaseScale());
    bind("zoomOut", "click", () => pdfViewer?.decreaseScale());
    bind("zoomFit", "click", () => { if (pdfViewer) pdfViewer.currentScaleValue = "page-width"; });
    bind("pdfDirection", "click", () => { horizontalPages = !horizontalPages; updatePdfDirection(); });
    bind("imageInvert", "click", () => setImageInverted(!imageInverted));
    bind("fullImage", "click", () => toggleFullscreen().catch((error) => notify(error.message, true)));
    document.addEventListener("keydown", (event) => emit("keyDown", event));
    window.addEventListener("blur", () => document.querySelector(".editor-wrap")?.classList.remove("ctrl-link"));
    window.addEventListener("beforeunload", (event) => emit("beforeUnload", event));
    setTheme(localStorage.getItem("readerDark") === "1");
    setImageInverted(localStorage.getItem("readerImageInverted") === "1");
    horizontalPages = localStorage.getItem("readerPdfHorizontal") === "1"
      || localStorage.getItem("readerPdfSpread") === "1";
    localStorage.removeItem("readerPdfSpread");
    updatePdfDirection();
    document.addEventListener("fullscreenchange", () => {
      const active = document.fullscreenElement === scanPane;
      byId("fullImage").textContent = active ? "退出全屏" : "全屏";
      requestAnimationFrame(() => pdfViewer?.update());
    });
  }

  const splitter = document.createElement("div");
  splitter.className = "pane-splitter";
  splitter.setAttribute("role", "separator");
  splitter.setAttribute("aria-label", "调整正文与扫描原图宽度");
  splitter.setAttribute("aria-orientation", "vertical");
  splitter.setAttribute("aria-valuemin", "25");
  splitter.setAttribute("aria-valuemax", "75");
  splitter.tabIndex = 0;
  grid.insertBefore(splitter, scanPane);

  const savedWidth = Number(localStorage.getItem("readerLeftPane"));
  if (savedWidth >= 25 && savedWidth <= 75) {
    grid.style.setProperty("--left-pane", `${savedWidth}%`);
  }

  const resizeTo = (clientX) => {
    const bounds = grid.getBoundingClientRect();
    const percent = Math.min(75, Math.max(25, ((clientX - bounds.left) / bounds.width) * 100));
    grid.style.setProperty("--left-pane", `${percent}%`);
    splitter.setAttribute("aria-valuenow", String(Math.round(percent)));
    return percent;
  };

  let dragging = false;
  let currentWidth = savedWidth || 54;
  splitter.setAttribute("aria-valuenow", String(Math.round(currentWidth)));

  splitter.addEventListener("pointerdown", (event) => {
    if (matchMedia("(max-width: 850px)").matches) return;
    dragging = true;
    splitter.classList.add("dragging");
    body.classList.add("resizing");
    splitter.setPointerCapture?.(event.pointerId);
    currentWidth = resizeTo(event.clientX);
    event.preventDefault();
  });

  splitter.addEventListener("pointermove", (event) => {
    if (dragging) currentWidth = resizeTo(event.clientX);
  });

  const stopResize = () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("dragging");
    body.classList.remove("resizing");
    localStorage.setItem("readerLeftPane", currentWidth.toFixed(2));
  };

  splitter.addEventListener("pointerup", stopResize);
  splitter.addEventListener("pointercancel", stopResize);
  splitter.addEventListener("dblclick", () => {
    currentWidth = 54;
    grid.style.setProperty("--left-pane", "54%");
    splitter.setAttribute("aria-valuenow", "54");
    localStorage.removeItem("readerLeftPane");
  });

  splitter.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") currentWidth = 25;
    else if (event.key === "End") currentWidth = 75;
    else {
      const step = event.shiftKey ? 5 : 2;
      currentWidth = Math.min(75, Math.max(25, currentWidth + (event.key === "ArrowRight" ? step : -step)));
    }
    grid.style.setProperty("--left-pane", `${currentWidth}%`);
    splitter.setAttribute("aria-valuenow", String(Math.round(currentWidth)));
    localStorage.setItem("readerLeftPane", currentWidth.toFixed(2));
  });

  const syncChromeMetrics = () => {
    const headerHeight = document.querySelector(".site-header")?.getBoundingClientRect().height || 64;
    const footerHeight = document.querySelector(".page-footer")?.getBoundingClientRect().height || 48;
    root.style.setProperty("--app-header-height", `${Math.round(headerHeight)}px`);
    root.style.setProperty("--app-footer-height", `${Math.round(footerHeight)}px`);
    window.dispatchEvent(new Event("reader-chrome-resize"));
  };
  const chromeResizeObserver = new ResizeObserver(syncChromeMetrics);
  chromeResizeObserver.observe(document.querySelector(".site-header"));
  chromeResizeObserver.observe(document.querySelector(".page-footer"));
  syncChromeMetrics();

  window.ReaderUI = {
    init, notify, setDirty, setHistoryButtons, renderVolumes, renderToc, renderNavigation, renderTools,
    setMode, setToc, setPdf, applyVisualTheme, showVisual, findOptions,
    setFindInfo: (text) => { byId("findInfo").textContent = text; },
    getSource: () => sourceEditor.value,
    setSource: (text) => { sourceEditor.value = text; },
    getSourceSelection: () => ({ start: sourceEditor.selectionStart || 0, end: sourceEditor.selectionEnd || 0 }),
    setSourceSelection: (start, end = start) => sourceEditor.setSelectionRange(start, end),
    replaceSourceRange: (text, start, end, selectionMode = "end") => sourceEditor.setRangeText(text, start, end, selectionMode),
    focusSource: () => sourceEditor.focus(),
    sourceScroll: () => ({ top: sourceEditor.scrollTop, left: sourceEditor.scrollLeft }),
    setSourceScroll: ({ top = 0, left = 0 }) => { sourceEditor.scrollTop = top; sourceEditor.scrollLeft = left; },
    scrollSourceSelectionIntoView,
    updateHighlight,
    getVisualDocument: () => visualFrame.contentDocument,
    setSourceLinkMode: (active) => document.querySelector(".editor-wrap")?.classList.toggle("ctrl-link", active),
    selectedVolume: () => byId("volumeSelect").value
  };
})();

/* =====================================================================
 * 编辑工具面板：可停靠 / 可浮动 / 可拉伸
 * 适用面板：
 *   - 编辑按钮框（#tagBar）：可停靠编辑框上/下方（与编辑框等宽）、
 *     窗口顶部/底部（与窗口等宽），或自由浮动。
 *   - 查找替换框（#findBar）：同上。
 * 交互：
 *   - 按住标题栏拖动 → 自由浮动；拖到窗口上/下边缘 → 自动停靠（全宽）。
 *   - 浮动状态四边/四角可拉伸；停靠状态下沿可用边沿拉伸高度。
 *   - 标题栏上的按钮可精确停靠；双击标题栏恢复默认（停靠编辑框上方）。
 *   布局与位置均记忆在 localStorage("readerDockPanels.v1")。
 * ===================================================================== */
(() => {
  "use strict";
  const LS_KEY = "readerDockPanels.v1";
  const SNAP = 56;       // 拖拽靠近上/下边缘的吸附距离
  const MIN_CONTROL_HEIGHT = 16;
  const BASE_CONTROL_HEIGHT = 28;
  const MAX_CONTROL_HEIGHT = 35;
  const TAG_BAR_MIN_HEIGHT = BASE_CONTROL_HEIGHT;
  const FIND_BAR_MIN_HEIGHT = 54;

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (_) { saved = {}; }

  const DOCK_DEFS = [
    ["editor-top",    "栏上", "停靠编辑框上方（与编辑框等宽）"],
    ["editor-bottom", "栏下", "停靠编辑框下方（与编辑框等宽）"],
    ["window-top",    "窗上", "停靠窗口顶部（与窗口等宽）"],
    ["window-bottom", "窗下", "停靠窗口底部（与窗口等宽）"],
    ["floating",      "浮动", "自由浮动（可拖动、可拉伸）"]
  ];

  const snapTop = document.createElement("div");
  snapTop.className = "fp-snap fp-snap-top";
  const snapBottom = document.createElement("div");
  snapBottom.className = "fp-snap fp-snap-bottom";
  document.body.append(snapTop, snapBottom);

  const panels = {};

  function chromeHeights() {
    return {
      header: Math.round(document.querySelector(".site-header")?.getBoundingClientRect().height || 0),
      footer: Math.round(document.querySelector(".page-footer")?.getBoundingClientRect().height || 0)
    };
  }

  function visibleWindowPanels(dock) {
    return Object.values(panels).filter((st) => st.dock === dock && st.panel.getClientRects().length);
  }

  function panelMinHeight(st) {
    const headerHeight = st.header?.getBoundingClientRect().height || 27;
    return Math.ceil(headerHeight + st.contentMinHeight);
  }

  function updateControlScale(st, height = st.panel.getBoundingClientRect().height) {
    const headerHeight = st.header.getBoundingClientRect().height || 27;
    const naturalContent = Math.max(20, st.naturalH - headerHeight);
    const contentHeight = Math.max(MIN_CONTROL_HEIGHT, height - headerHeight);
    // Let controls respond to the panel without becoming comically large or
    // too small to click. Extra space beyond this range remains as breathing
    // room around the vertically centred control group.
    const controlHeight = Math.min(MAX_CONTROL_HEIGHT, Math.max(
      MIN_CONTROL_HEIGHT,
      BASE_CONTROL_HEIGHT * contentHeight / naturalContent
    ));
    st.panel.style.setProperty("--fp-header-height", `${headerHeight}px`);
    st.panel.style.setProperty("--fp-control-height", `${controlHeight.toFixed(2)}px`);
    st.panel.style.setProperty("--fp-pad-y", `${Math.max(1, controlHeight / BASE_CONTROL_HEIGHT * 5).toFixed(2)}px`);
  }

  const panelResizeObserver = new ResizeObserver((entries) => {
    for (const { target } of entries) {
      const st = panels[target.dataset.panel];
      // Auto-height panels are content-sized, so scaling them here would feed
      // back into their height. User-resized panels always have an explicit h.
      if (st?.h != null) updateControlScale(st);
    }
  });

  // Window-docked panels take up real layout space and stack instead of covering one another.
  function updateWindowDockLayout() {
    const { header, footer } = chromeHeights();
    const topPanels = visibleWindowPanels("window-top");
    const bottomPanels = visibleWindowPanels("window-bottom");
    const windowPanels = [...topPanels, ...bottomPanels];
    let remaining = Math.max(
      windowPanels.reduce((sum, st) => sum + panelMinHeight(st), 0),
      innerHeight - header - footer - 120
    );
    windowPanels.forEach((st, index) => {
      const reserved = windowPanels.slice(index + 1).reduce((sum, other) => sum + panelMinHeight(other), 0);
      const minimum = panelMinHeight(st);
      const current = Math.max(minimum, st.panel.getBoundingClientRect().height);
      const height = Math.min(current, Math.max(minimum, remaining - reserved));
      st.panel.style.height = `${height}px`;
      if (st.h != null) st.h = height;
      updateControlScale(st, height);
      remaining -= height;
    });
    let top = 0;
    for (const st of topPanels) {
      st.panel.style.top = `${header + top}px`;
      top += Math.round(st.panel.getBoundingClientRect().height);
    }
    let bottom = 0;
    for (const st of bottomPanels) {
      st.panel.style.bottom = `${footer + bottom}px`;
      bottom += Math.round(st.panel.getBoundingClientRect().height);
    }
    document.documentElement.style.setProperty("--window-dock-top", `${top}px`);
    document.documentElement.style.setProperty("--window-dock-bottom", `${bottom}px`);
    snapTop.style.top = `${header + top}px`;
    snapBottom.style.bottom = `${footer + bottom}px`;
  }

  function clampFloatingPanel(st) {
    if (st.dock !== "floating") return;
    const { header, footer } = chromeHeights();
    const height = st.panel.getBoundingClientRect().height || st.h || st.naturalH;
    st.w = Math.min(Math.max(150, st.w), innerWidth);
    st.h = Math.min(Math.max(panelMinHeight(st), st.h || height), Math.max(80, innerHeight - header - footer));
    st.x = Math.min(innerWidth - 36, Math.max(36 - st.w, st.x));
    st.y = Math.min(innerHeight - footer - 28, Math.max(header, st.y));
    st.panel.style.left = `${st.x}px`;
    st.panel.style.top = `${st.y}px`;
    st.panel.style.width = `${st.w}px`;
    st.panel.style.height = `${st.h}px`;
  }

  function panelHeightLimit(st) {
    const { header, footer } = chromeHeights();
    const available = Math.max(80, innerHeight - header - footer);
    if (st.dock.startsWith("window-")) {
      const occupied = Object.values(panels).reduce((sum, other) => {
        if (other === st || !other.dock.startsWith("window-") || !other.panel.getClientRects().length) return sum;
        return sum + other.panel.getBoundingClientRect().height;
      }, 0);
      return Math.max(panelMinHeight(st), available - occupied - 120);
    }
    if (st.dock.startsWith("editor-")) {
      return Math.max(panelMinHeight(st), st.panel.parentElement.getBoundingClientRect().height - 100);
    }
    return available;
  }

  /* ---------------- 布局应用 ---------------- */
  function applyPanel(st) {
    const panel = st.panel;
    const parent = panel.parentElement;
    panel.classList.remove("dock-editor-top", "dock-editor-bottom", "dock-window-top", "dock-window-bottom", "floating");
    parent.classList.remove("bar-fixed", "bar-bottom");

    switch (st.dock) {
      case "editor-top":
        panel.classList.add("dock-editor-top");
        break;
      case "editor-bottom":
        panel.classList.add("dock-editor-bottom");
        parent.classList.add("bar-bottom");
        break;
      case "window-top":
        panel.classList.add("dock-window-top");
        parent.classList.add("bar-fixed");
        break;
      case "window-bottom":
        panel.classList.add("dock-window-bottom");
        parent.classList.add("bar-fixed");
        break;
      case "floating":
        panel.classList.add("floating");
        parent.classList.add("bar-fixed");
        break;
    }

    panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = panel.style.width = "";
    if (st.dock === "floating") {
      panel.style.left = `${st.x}px`;
      panel.style.top = `${st.y}px`;
      panel.style.width = `${st.w}px`;
    }

    const fixed = st.dock === "window-top" || st.dock === "window-bottom" || st.dock === "floating";
    let h = fixed ? (st.h != null ? st.h : st.naturalH) : (st.h != null ? st.h : null);
    if (h != null) {
      h = Math.min(Math.max(panelMinHeight(st), h), panelHeightLimit(st));
      st.h = st.h == null && st.dock !== "floating" ? null : h;
    }
    panel.style.height = h != null ? `${h}px` : "";
    updateControlScale(st, h || panel.getBoundingClientRect().height || st.naturalH);
    clampFloatingPanel(st);

    panel.querySelectorAll(".fp-dock").forEach((btn) => {
      const active = btn.dataset.dock === st.dock;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    requestAnimationFrame(updateWindowDockLayout);
  }

  function dock(st, target) {
    if (target === "floating" && st.dock !== "floating") {
      const rect = st.panel.getBoundingClientRect();
      st.x = rect.left; st.y = rect.top;
      st.w = rect.width;
      if (st.h == null) st.h = Math.round(rect.height);
    }
    st.dock = target;
    applyPanel(st);
    save();
  }

  /* ---------------- 拖动（自由移动 + 吸附停靠） ---------------- */
  function bindDrag(st) {
    st.header.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest(".fp-dock, .fp-handle")) return;
      event.preventDefault();

      const rect = st.panel.getBoundingClientRect();
      if (st.dock !== "floating") {
        st.dock = "floating";
        st.x = rect.left; st.y = rect.top;
        st.w = rect.width;
        if (st.h == null) st.h = Math.round(rect.height);
        applyPanel(st);
      }
      const offsetX = event.clientX - st.x;
      const offsetY = event.clientY - st.y;
      let snap = null;
      document.body.classList.add("panel-dragging");

      const move = (ev) => {
        const { header, footer } = chromeHeights();
        const panelWidth = st.panel.getBoundingClientRect().width;
        st.x = Math.min(innerWidth - 36, Math.max(36 - panelWidth, ev.clientX - offsetX));
        st.y = Math.min(innerHeight - footer - 28, Math.max(header, ev.clientY - offsetY));
        st.panel.style.left = `${st.x}px`;
        st.panel.style.top = `${st.y}px`;
        const nearTop = ev.clientY < header + SNAP + 6;
        const nearBottom = ev.clientY > innerHeight - footer - SNAP - 6;
        snap = nearTop ? "top" : nearBottom ? "bottom" : null;
        snapTop.classList.toggle("active", snap === "top");
        snapBottom.classList.toggle("active", snap === "bottom");
      };

      const clean = () => {
        snapTop.classList.remove("active");
        snapBottom.classList.remove("active");
        document.body.classList.remove("panel-dragging");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", clean);
      };

      const up = () => {
        clean();
        if (snap === "top") dock(st, "window-top");
        else if (snap === "bottom") dock(st, "window-bottom");
        else save();
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
      window.addEventListener("pointercancel", clean, { once: true });
    });
  }

  /* ---------------- 拉伸 ---------------- */
  function bindResize(st, handle, dir) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const rect = st.panel.getBoundingClientRect();
      const startX = event.clientX, startY = event.clientY;
      const base = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
      document.body.classList.add("panel-dragging");

      const move = (ev) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        let { x, y, w, h } = base;
        const maxHeight = panelHeightLimit(st);
        if (dir.includes("e")) w = Math.min(innerWidth - x, Math.max(150, base.w + dx));
        if (dir.includes("w")) {
          w = Math.min(base.x + base.w, Math.max(150, base.w - dx));
          x = base.x + base.w - w;
        }
        if (dir.includes("s")) h = Math.min(maxHeight, Math.max(panelMinHeight(st), base.h + dy));
        if (dir.includes("n")) { h = Math.min(maxHeight, Math.max(panelMinHeight(st), base.h - dy)); y = base.y + (base.h - h); }
        st.x = x; st.y = y; st.w = w; st.h = h;
        if (st.dock === "floating") {
          st.panel.style.left = `${x}px`;
          st.panel.style.top = `${y}px`;
          st.panel.style.width = `${w}px`;
        }
        st.panel.style.height = `${h}px`;
        updateControlScale(st, h);
        updateWindowDockLayout();
      };

      const clean = () => {
        document.body.classList.remove("panel-dragging");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", clean);
      };

      const up = () => {
        clean();
        save();
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
      window.addEventListener("pointercancel", clean, { once: true });
    });
  }

  /* ---------------- 持久化 ---------------- */
  function save() {
    const data = {};
    for (const id in panels) {
      const s = panels[id];
      data[id] = {
        dock: s.dock,
        x: Math.round(s.x), y: Math.round(s.y),
        w: Math.round(s.w),
        h: s.h == null ? null : Math.round(s.h)
      };
    }
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (_) { /* ignore */ }
  }

  /* ---------------- 面板装配 ---------------- */
  function setupPanel(id, contentSelector, title, fallbackH) {
    const content = document.querySelector(contentSelector);
    if (!content) return null;

    const panel = document.createElement("div");
    panel.className = "float-panel";
    panel.dataset.panel = id;

    const header = document.createElement("div");
    header.className = "fp-header";
    header.title = `${title}：按住标题栏拖动可自由浮动，拖到窗口上/下边缘可停靠，双击恢复默认`;

    const grip = document.createElement("span");
    grip.className = "fp-grip";
    grip.textContent = "≡";

    const titleEl = document.createElement("span");
    titleEl.className = "fp-title";
    titleEl.textContent = title;

    const actions = document.createElement("div");
    actions.className = "fp-actions";
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", `${title}停靠位置`);
    for (const [dockName, label, tip] of DOCK_DEFS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fp-dock";
      btn.dataset.dock = dockName;
      btn.textContent = label;
      btn.title = tip;
      btn.setAttribute("aria-label", tip);
      actions.appendChild(btn);
    }
    header.append(grip, titleEl, actions);

    content.parentNode.insertBefore(panel, content);
    panel.append(header, content);

    const st = Object.assign({
      id, dock: "editor-top",
      x: 60, y: 96, w: 520, h: null, naturalH: Math.max(28, fallbackH || 48)
    }, saved[id] || {});
    st.contentMinHeight = id === "findBar" ? FIND_BAR_MIN_HEIGHT : TAG_BAR_MIN_HEIGHT;
    st.panel = panel;
    st.header = header;
    st.content = content;
    panels[id] = st;
    panel.style.setProperty("--fp-content-min-height", `${st.contentMinHeight}px`);
    panelResizeObserver.observe(panel);

    // 隐藏面板采用回退高度，避免为了测量而短暂显示并与异步模式切换发生竞争。
    const measured = Math.round(panel.offsetHeight);
    if (measured > 0) st.naturalH = measured;

    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      const handle = document.createElement("div");
      handle.className = `fp-handle fp-handle-${dir}`;
      handle.dataset.dir = dir;
      panel.appendChild(handle);
      bindResize(st, handle, dir);
    }

    bindDrag(st);
    actions.addEventListener("click", (event) => {
      const btn = event.target.closest(".fp-dock");
      if (btn) dock(st, btn.dataset.dock);
    });
    header.addEventListener("dblclick", (event) => {
      if (event.target.closest(".fp-actions, .fp-dock")) return;
      st.dock = "editor-top";
      st.h = null;
      st.x = 60; st.y = 96; st.w = 520;
      applyPanel(st);
      save();
    });

    applyPanel(st);
    return st;
  }

  setupPanel("tagBar", "#tagBar", "编辑按钮", 56);
  setupPanel("findBar", "#findBar", "查找替换", 82);
  window.addEventListener("reader-mode-change", updateWindowDockLayout);
  window.addEventListener("reader-chrome-resize", updateWindowDockLayout);
  window.addEventListener("resize", () => {
    Object.values(panels).forEach(clampFloatingPanel);
    updateWindowDockLayout();
  });
  updateWindowDockLayout();
})();
