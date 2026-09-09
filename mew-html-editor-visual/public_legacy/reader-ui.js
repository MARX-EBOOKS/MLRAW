(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const root = document.documentElement;
  const body = document.body;
  const grid = document.querySelector(".reader-grid");
  const scanPane = document.querySelector(".scan-pane");
  const sourceEditor = byId("editor");
  const visualFrame = byId("visualEditor");
  const pdfFrame = byId("pdfFrame");
  const listeners = {};
  let initialized = false;
  let statusTimer = null;
  let pendingPdfOptions = null;
  let pdfRuntimePromise = null, pdfViewer = null, pdfLinkService = null, pdfLoadingTask = null;
  let pdfUrl = "", pdfPageLabels = null, pdfFrameReady = false, scrollMode = null, pdfWriteTimer = null, pdfRevision = 0, pdfRoot = null;
  const PDF_SETTINGS_KEY = "readerPdfSettings.v1";
  const PDF_DEFAULTS = { brightness: 100, paper: "#ffffff", ink: "#000000", invert: false, horizontal: false, scale: "page-width" };
  let pdfSettings = { ...PDF_DEFAULTS };
  const PDF_DIRECT_HTML = `<svg aria-hidden="true" width="0" height="0"><filter id="scanColorFilter" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR id="filterR" type="table" tableValues="0 1"/><feFuncG id="filterG" type="table" tableValues="0 1"/><feFuncB id="filterB" type="table" tableValues="0 1"/></feComponentTransfer></filter></svg><div class="pdf-tools"><div class="pdf-group"><button id="direction" type="button">左右翻页</button><button id="settings" type="button">显示设置</button></div><div class="pdf-group pdf-zoom"><button id="zoomOut" type="button" aria-label="缩小 PDF">−</button><input id="zoomValue" type="text" inputmode="decimal" maxlength="8" value="页宽" aria-label="PDF 缩放比例" title="输入 25%–1000% 并按回车；输入“页宽”恢复适合页宽"><button id="zoomIn" type="button" aria-label="放大 PDF">＋</button></div><button id="full" type="button">全屏</button></div><div id="stage"><div id="viewer" class="pdfViewer"></div><p id="missing">正在载入 PDF…</p></div><dialog id="settingsDialog"><form method="dialog"><header><strong>扫描件显示设置</strong><button value="close">×</button></header><label>亮度 <output id="brightnessValue"></output><input id="brightness" type="range" min="50" max="160"></label><label>背景色 <input id="paper" type="color"></label><label>文字色 <input id="ink" type="color"></label><label class="toggle"><input id="invert" type="checkbox">反色</label><footer><button id="reset" type="button">恢复默认</button><button value="close">完成</button></footer></form></dialog>`;

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

  function setDirty(dirty) {
    byId("saveBtn").classList.toggle("dirty", dirty);
    byId("saveBtn").textContent = dirty ? "保存*" : "保存";
    byId("prevBtn").title = dirty ? "Alt+← & 保存" : "Alt+←";
    byId("nextPageBtn").title = dirty ? "Alt+→ & 保存" : "Alt+→";
    const tagPrev = byId("tagPrevBtn");
    const tagNext = byId("tagNextPageBtn");
    if (tagPrev) tagPrev.title = dirty ? "上一页 · 将先自动保存" : "上一页";
    if (tagNext) tagNext.title = dirty ? "下一页 · 将先自动保存" : "下一页";
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
    byId("pagePosition").textContent = view.pageTotal;
    if (document.activeElement !== byId("pageInput")) byId("pageInput").value = view.page;
    byId("volumeSelect").value = view.volume;
    byId("prevBtn").disabled = !view.hasPrevious;
    byId("nextPageBtn").disabled = !view.hasNext;
    const tagPrev = byId("tagPrevBtn");
    const tagNext = byId("tagNextPageBtn");
    if (tagPrev) tagPrev.disabled = !view.hasPrevious;
    if (tagNext) tagNext.disabled = !view.hasNext;
    const panel = document.querySelector('.float-panel[data-panel="tagBar"]');
    const pageTitle = view.page ? `编辑按钮 · 第 ${view.page} 页 · ${view.pageIndex} / ${view.pageTotal}` : "编辑按钮";
    const panelTitle = panel?.querySelector(".fp-title");
    const panelHeader = panel?.querySelector(".fp-header");
    if (panelTitle) panelTitle.textContent = pageTitle;
    if (panelHeader) panelHeader.title = `${pageTitle}：按住标题栏拖动可自由浮动，拖到窗口上/下边缘可停靠，双击恢复默认`;
    byId("saveBtn").disabled = !view.editable;
    document.querySelectorAll("#tocList a").forEach((link) =>
      link.classList.toggle("active", Number(link.dataset.page) === view.chapterPage));
  }

  function renderTools(tags, attrs) {
    const bar = byId("tagBar");
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    const pageButton = (id, direction, label) => {
      const button = document.createElement("button");
      button.id = id;
      button.type = "button";
      button.className = "tag-page-button";
      button.dataset.pageAdjacent = direction;
      button.textContent = label;
      button.title = direction < 0 ? "Prev" : "Next";
      return button;
    };
    bar.replaceChildren(
      ...tags.map((tag, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.tag = index;
        button.textContent = tag.label;
        button.title = tag.hotkey ? `Alt+${tag.hotkey === "Enter" ? "Enter" : tag.hotkey.toUpperCase()}` : tag.title || tag.label;
        return button;
      }),
      spacer,
      ...attrs.map((attr, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.attr = index;
        button.textContent = attr.label;
        return button;
      }),
      spacer.cloneNode(true),
      pageButton("tagPrevBtn", -1, "← "),
      pageButton("tagNextPageBtn", 1, " →")
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
    byId("highlight").innerHTML = html;
    syncHighlightScroll();
  }

  function syncHighlightScroll() {
    const highlight = byId("highlight");
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
    syncHighlightScroll();
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

  const frameId = (id) => pdfRoot?.querySelector(`#${id}`);
  function normalizedPdfSettings(value = {}) {
    const color = (input, fallback) => /^#[0-9a-f]{6}$/i.test(String(input)) ? String(input).toLowerCase() : fallback;
    const scale = typeof value.scale === "string" && value.scale.length <= 32 ? value.scale : PDF_DEFAULTS.scale;
    return { ...PDF_DEFAULTS, ...value, brightness: Math.max(50, Math.min(160, Number(value.brightness) || 100)), paper: color(value.paper, PDF_DEFAULTS.paper), ink: color(value.ink, PDF_DEFAULTS.ink), invert: Boolean(value.invert), horizontal: Boolean(value.horizontal), scale };
  }
  function applyPdfSettings() {
    const stage = frameId("stage");
    if (!stage) return;
    stage.style.setProperty("--paper", pdfSettings.paper);
    const channels = (hex) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const ink = channels(pdfSettings.ink), paper = channels(pdfSettings.paper);
    ["filterR", "filterG", "filterB"].forEach((id, index) => frameId(id)?.setAttribute("tableValues", `${ink[index]} ${paper[index]}`));
    const filter = [];
    if (pdfSettings.ink !== PDF_DEFAULTS.ink || pdfSettings.paper !== PDF_DEFAULTS.paper) filter.push("url(#scanColorFilter)");
    if (pdfSettings.brightness !== 100) filter.push(`brightness(${pdfSettings.brightness}%)`);
    if (pdfSettings.invert) filter.push("invert(1)");
    stage.style.setProperty("--scan-filter", filter.join(" ") || "none");
    frameId("brightness").value = pdfSettings.brightness; frameId("brightnessValue").value = `${pdfSettings.brightness}%`;
    frameId("paper").value = pdfSettings.paper; frameId("ink").value = pdfSettings.ink; frameId("invert").checked = pdfSettings.invert;
    const direction = frameId("direction"); direction.setAttribute("aria-pressed", String(pdfSettings.horizontal)); direction.textContent = pdfSettings.horizontal ? "上下翻页" : "左右翻页";
    if (pdfViewer && scrollMode) pdfViewer.scrollMode = pdfSettings.horizontal ? scrollMode.HORIZONTAL : scrollMode.VERTICAL;
  }
  function savePdfSettings() {
    localStorage.setItem(PDF_SETTINGS_KEY, JSON.stringify(pdfSettings));
    clearTimeout(pdfWriteTimer); pdfWriteTimer = setTimeout(() => fetch("/api/reader/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(pdfSettings) }).catch(() => {}), 350);
  }
  function changePdfSettings(patch) { pdfSettings = normalizedPdfSettings({ ...pdfSettings, ...patch }); applyPdfSettings(); savePdfSettings(); }
  function setPdfStatus(message = "") { const node = frameId("missing"); if (!node) return; node.hidden = !message; if (message) node.textContent = message; }
  function showPdfScaleValue() {
    const input = frameId("zoomValue");
    if (!input) return;
    input.value = pdfViewer?.currentScale ? `${Math.round(pdfViewer.currentScale * 100)}%` : "页宽";
  }
  function applyPdfScaleInput() {
    const input = frameId("zoomValue");
    if (!input || !pdfViewer) return showPdfScaleValue();
    const value = input.value.trim().toLowerCase();
    if (["页宽", "适合页宽", "page-width", "auto"].includes(value)) {
      pdfViewer.currentScaleValue = "page-width";
      return;
    }
    const match = value.match(/^(\d+(?:\.\d+)?)\s*%?$/);
    const percent = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(percent) || percent < 25 || percent > 1000) {
      showPdfScaleValue();
      notify("PDF 缩放比例请输入 25%–1000%", true);
      return;
    }
    pdfViewer.currentScaleValue = String(percent / 100);
  }
  function pdfPageNumberForLabel(label) {
    const matches = pdfPageLabels?.map((value, index) => String(value) === String(label) ? index + 1 : 0).filter(Boolean);
    const current = pdfViewer?.currentPageNumber || matches?.[0];
    return matches?.reduce((best, page) => Math.abs(page - current) < Math.abs(best - current) ? page : best, matches[0]) || null;
  }
  function showPendingPdfPage() { const page = pdfPageNumberForLabel(pendingPdfOptions?.pageLabel); if (page) pdfViewer.currentPageNumber = page; }
  async function ensurePdfRuntime() {
    if (pdfRuntimePromise) return pdfRuntimePromise;
    pdfRuntimePromise = (async () => {
      const pdfjs = await import("/vendor/pdfjs/build/pdf.mjs"); globalThis.pdfjsLib = pdfjs;
      const viewerModule = await import("/vendor/pdfjs/web/pdf_viewer.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.mjs";
      const eventBus = new viewerModule.EventBus(); pdfLinkService = new viewerModule.PDFLinkService({ eventBus });
      pdfViewer = new viewerModule.PDFViewer({ container: frameId("stage"), viewer: frameId("viewer"), eventBus, linkService: pdfLinkService, imageResourcesPath: "/vendor/pdfjs/web/images/" });
      pdfLinkService.setViewer(pdfViewer); scrollMode = viewerModule.ScrollMode;
      eventBus.on("pagesinit", () => { pdfViewer.setPageLabels(pdfPageLabels); pdfViewer.currentScaleValue = pdfSettings.scale; applyPdfSettings(); showPendingPdfPage(); setPdfStatus(); });
      eventBus.on("pagechanging", ({ pageNumber, pageLabel }) => { if (pageNumber != null) emit("pdfPageChange", { pageNumber, pageLabel }); });
      eventBus.on("scalechanging", ({ scale, presetValue }) => { pdfSettings.scale = presetValue || String(scale); frameId("zoomValue").value = `${Math.round(scale * 100)}%`; savePdfSettings(); });
      return pdfjs;
    })().catch((error) => { pdfRuntimePromise = null; throw error; });
    return pdfRuntimePromise;
  }
  async function setPdf(options) {
    pendingPdfOptions = options;
    if (!pdfFrameReady) return;
    const pdfjs = await ensurePdfRuntime();
    const url = options.url || "";
    if (url === pdfUrl && (pdfViewer.pdfDocument || pdfLoadingTask)) return showPendingPdfPage();
    const revision = ++pdfRevision;
    pdfUrl = url; setPdfStatus(url ? "正在载入 PDF…" : "此卷未配置 PDF");
    pdfViewer.setDocument(null); pdfLinkService.setDocument(null); pdfPageLabels = null;
    const oldTask = pdfLoadingTask; pdfLoadingTask = null; await oldTask?.destroy();
    if (!url || revision !== pdfRevision) return;
    try {
      const task = pdfjs.getDocument({ url, cMapUrl: "/vendor/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/vendor/pdfjs/standard_fonts/", wasmUrl: "/vendor/pdfjs/wasm/" });
      pdfLoadingTask = task;
      const document = await task.promise;
      if (revision !== pdfRevision || task !== pdfLoadingTask) return document.destroy();
      pdfPageLabels = await document.getPageLabels() || Array.from({ length: document.numPages }, (_, index) => String(index + 1));
      if (revision !== pdfRevision) return document.destroy();
      pdfViewer.setDocument(document); pdfLinkService.setDocument(document);
    } catch (error) {
      if (revision !== pdfRevision) return;
      pdfLoadingTask = null; setPdfStatus(`PDF 载入失败：${error.message}`); notify(`PDF 载入失败：${error.message}`, true);
    }
  }
  function initPdfFrame() {
    pdfRoot = pdfFrame;
    pdfRoot.innerHTML = PDF_DIRECT_HTML;
    (async () => {
      pdfFrameReady = true;
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(PDF_SETTINGS_KEY) || "{}"); } catch { localStorage.removeItem(PDF_SETTINGS_KEY); }
      const legacy = {};
      if (localStorage.getItem("readerPdfHorizontal") != null) legacy.horizontal = localStorage.getItem("readerPdfHorizontal") === "1";
      if (localStorage.getItem("readerImageInverted") != null) legacy.invert = localStorage.getItem("readerImageInverted") === "1";
      if (localStorage.getItem("readerPdfScaleValue")) legacy.scale = localStorage.getItem("readerPdfScaleValue");
      saved = { ...legacy, ...saved };
      try { pdfSettings = normalizedPdfSettings({ ...(await fetch("/api/reader/settings").then((r) => r.ok ? r.json() : {})), ...saved }); } catch { pdfSettings = normalizedPdfSettings(saved); }
      applyPdfSettings();
      frameId("zoomIn").onclick = () => pdfViewer?.increaseScale(); frameId("zoomOut").onclick = () => pdfViewer?.decreaseScale();
      frameId("zoomValue").onchange = applyPdfScaleInput;
      frameId("zoomValue").onkeydown = (event) => {
        if (event.key === "Enter") { event.preventDefault(); applyPdfScaleInput(); event.currentTarget.select(); }
        if (event.key === "Escape") { event.preventDefault(); showPdfScaleValue(); event.currentTarget.blur(); }
      };
      frameId("zoomValue").ondblclick = () => { if (pdfViewer) pdfViewer.currentScaleValue = "page-width"; };
      frameId("direction").onclick = () => changePdfSettings({ horizontal: !pdfSettings.horizontal }); frameId("settings").onclick = () => frameId("settingsDialog").showModal(); frameId("brightness").oninput = (event) => changePdfSettings({ brightness: event.target.value }); frameId("paper").oninput = (event) => changePdfSettings({ paper: event.target.value }); frameId("ink").oninput = (event) => changePdfSettings({ ink: event.target.value }); frameId("invert").onchange = (event) => changePdfSettings({ invert: event.target.checked }); frameId("reset").onclick = () => changePdfSettings(PDF_DEFAULTS); frameId("full").onclick = () => (document.fullscreenElement ? document.exitFullscreen() : pdfFrame.requestFullscreen()).catch((error) => notify(error.message, true));
      document.addEventListener("fullscreenchange", () => { frameId("full").textContent = document.fullscreenElement ? "退出全屏" : "全屏"; requestAnimationFrame(() => pdfViewer?.update()); });
      if (pendingPdfOptions) setPdf(pendingPdfOptions);
    })().catch((error) => notify(error.message, true));
  }

  function init(handlers) {
    Object.assign(listeners, handlers);
    if (initialized) return;
    initialized = true;
    initPdfFrame();
    bind("modeBtn", "click", () => emit("mode"));
    bind("saveBtn", "click", () => emit("save"));
    bind("undoBtn", "click", () => emit("undo"));
    bind("redoBtn", "click", () => emit("redo"));
    bind("volumeSelect", "change", (event) => emit("volume", event.target.value));
    bind("pageForm", "submit", (event) => {
      event.preventDefault();
      const input = byId("pageInput");
      const page = Number(input.value);
      input.blur();
      emit("page", page);
    });
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
      const adjacent = event.target.closest("[data-page-adjacent]");
      const tag = event.target.closest("[data-tag]");
      const attr = event.target.closest("[data-attr]");
      if (adjacent) emit("adjacent", Number(adjacent.dataset.pageAdjacent));
      if (tag) emit("tag", Number(tag.dataset.tag));
      if (attr) emit("attr", Number(attr.dataset.attr));
    });
    sourceEditor.addEventListener("beforeinput", () => emit("beforeEdit"));
    sourceEditor.addEventListener("input", () => emit("sourceInput"));
    sourceEditor.addEventListener("scroll", syncHighlightScroll);
    sourceEditor.addEventListener("dblclick", () => emit("sourceDoubleClick"));
    byId("highlight").addEventListener("click", (event) => emit("highlightClick", event));
    bind("findBtn", "click", () => emit("find"));
    bind("nextBtn", "click", () => emit("nextMatch"));
    bind("replaceBtn", "click", () => emit("replace"));
    bind("allBtn", "click", () => emit("replaceAll"));
    ["findText", "regexBox", "caseBox"].forEach((id) => bind(id, id === "findText" ? "input" : "change", () => emit("findChanged")));
    document.addEventListener("keydown", (event) => emit("keyDown", event));
    window.addEventListener("blur", () => document.querySelector(".editor-wrap")?.classList.remove("ctrl-link"));
    window.addEventListener("beforeunload", (event) => emit("beforeUnload", event));
    setTheme(localStorage.getItem("readerDark") === "1");
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
    const footerHeight = document.querySelector(".page-footer")?.getBoundingClientRect().height || 0;
    root.style.setProperty("--app-header-height", `${Math.round(headerHeight)}px`);
    root.style.setProperty("--app-footer-height", `${Math.round(footerHeight)}px`);
    window.dispatchEvent(new Event("reader-chrome-resize"));
  };
  const chromeResizeObserver = new ResizeObserver(syncChromeMetrics);
  chromeResizeObserver.observe(document.querySelector(".site-header"));
  const pageFooter = document.querySelector(".page-footer");
  if (pageFooter) chromeResizeObserver.observe(pageFooter);
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
  const MIN_CONTROL_SCALE = .8;
  const MAX_CONTROL_SCALE = 1.6;
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

  function growTagPanelToFit(st) {
    if (st.id !== "tagBar" || st.h == null) return;
    const headerHeight = st.header.getBoundingClientRect().height || 27;
    const panelBorderHeight = st.panel.offsetHeight - st.panel.clientHeight;
    const requiredHeight = Math.ceil(headerHeight + st.content.scrollHeight + panelBorderHeight);
    if (requiredHeight <= st.h) return;
    st.h = Math.min(requiredHeight, panelHeightLimit(st));
    st.panel.style.height = `${st.h}px`;
  }

  function updateControlScale(st, height = st.panel.getBoundingClientRect().height) {
    const headerHeight = st.header.getBoundingClientRect().height || 27;
    if (st.id === "tagBar") {
      st.scale = Math.min(MAX_CONTROL_SCALE, Math.max(MIN_CONTROL_SCALE, Number(st.scale) || 1));
      st.contentMinHeight = Math.ceil(TAG_BAR_MIN_HEIGHT * st.scale);
      st.panel.style.setProperty("--fp-header-height", `${headerHeight}px`);
      st.panel.style.setProperty("--fp-scale", st.scale);
      st.panel.style.setProperty("--fp-content-min-height", `${st.contentMinHeight}px`);
      if (st.scaleReset) st.scaleReset.textContent = `${Math.round(st.scale * 100)}%`;
      if (st.scaleSmaller) st.scaleSmaller.disabled = st.scale <= MIN_CONTROL_SCALE;
      if (st.scaleLarger) st.scaleLarger.disabled = st.scale >= MAX_CONTROL_SCALE;
      return;
    }
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
    panel.classList.toggle("auto-height", h == null);
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
      if (event.target.closest(".fp-actions, .fp-handle, button")) return;
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
        h: s.h == null ? null : Math.round(s.h),
        scale: s.scale
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
    actions.setAttribute("aria-label", id === "tagBar" ? `${title}按钮尺寸与停靠位置` : `${title}停靠位置`);
    let scaleActions = null;
    if (id === "tagBar") {
      scaleActions = document.createElement("span");
      scaleActions.className = "fp-scale-actions";
      for (const [name, label, tip] of [["smaller", "−", "缩小标签按钮"], ["reset", "100%", "恢复默认按钮尺寸"], ["larger", "＋", "放大标签按钮"]]) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "fp-scale-control";
        btn.dataset.scaleAction = name;
        btn.textContent = label;
        btn.title = tip;
        btn.setAttribute("aria-label", tip);
        scaleActions.appendChild(btn);
      }
      actions.appendChild(scaleActions);
    }
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
      x: 60, y: 96, w: 520, h: null, scale: 1, naturalH: Math.max(28, fallbackH || 48)
    }, saved[id] || {});
    st.contentMinHeight = id === "findBar" ? FIND_BAR_MIN_HEIGHT : TAG_BAR_MIN_HEIGHT;
    st.panel = panel;
    st.header = header;
    st.content = content;
    if (scaleActions) {
      st.scaleSmaller = scaleActions.querySelector('[data-scale-action="smaller"]');
      st.scaleReset = scaleActions.querySelector('[data-scale-action="reset"]');
      st.scaleLarger = scaleActions.querySelector('[data-scale-action="larger"]');
    }
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
    scaleActions?.addEventListener("pointerdown", (event) => {
      if (!event.target.closest("[data-scale-action]")) return;
      event.preventDefault();
      event.stopPropagation();
    });
    scaleActions?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-scale-action]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      if (button.dataset.scaleAction === "reset") st.scale = 1;
      else st.scale = Math.round((st.scale + (button.dataset.scaleAction === "larger" ? .1 : -.1)) * 10) / 10;
      updateControlScale(st);
      growTagPanelToFit(st);
      if (st.h != null && st.h < panelMinHeight(st)) {
        st.h = panelMinHeight(st);
        st.panel.style.height = `${st.h}px`;
      }
      updateWindowDockLayout();
      save();
    });
    actions.addEventListener("click", (event) => {
      const btn = event.target.closest(".fp-dock");
      if (btn) dock(st, btn.dataset.dock);
    });
    header.addEventListener("dblclick", (event) => {
      if (event.target.closest(".fp-actions, button")) return;
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
