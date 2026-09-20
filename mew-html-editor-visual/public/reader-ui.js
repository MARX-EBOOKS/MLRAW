(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const element = (tag, className = "", textContent = "", properties = {}) =>
    Object.assign(document.createElement(tag), { className, textContent }, properties);
  const button = (label, title = label, properties = {}) =>
    element("button", "", label, { type: "button", title, ...properties });
  const root = document.documentElement;
  const body = document.body;
  const grid = document.querySelector(".reader-grid");
  const scanPane = document.querySelector(".scan-pane");
  const visualFrame = byId("visualEditor");
  const pdfFrame = byId("pdfFrame");
  const listeners = {};
  let initialized = false;
  let editorScale = 1;
  let statusTimer = null;
  let pendingPdfOptions = null;
  let pdfRuntimePromise = null, pdfViewer = null, pdfLinkService = null, pdfLoadingTask = null;
  let pdfUrl = "", pdfPageLabels = null, scrollMode = null, pdfWriteTimer = null, pdfRevision = 0;
  let pdfShortcutActive = false;
  let pdfContextPageNumber = null;
  const PDF_SETTINGS_KEY = "readerPdfSettings.v1";
  const PDF_DEFAULTS = { brightness: 100, paper: "#ffffff", ink: "#000000", invert: false, horizontal: false, scale: "page-width" };
  let pdfSettings = { ...PDF_DEFAULTS };
  const PDF_DIRECT_HTML = `<svg aria-hidden="true" width="0" height="0"><filter id="scanColorFilter" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR id="filterR" type="table" tableValues="0 1"/><feFuncG id="filterG" type="table" tableValues="0 1"/><feFuncB id="filterB" type="table" tableValues="0 1"/></feComponentTransfer></filter></svg><div class="pdf-tools"><div class="pdf-group"><button id="direction" type="button">左右翻页</button><button id="settings" type="button">显示设置</button></div><div class="pdf-tools-end"><div class="pdf-group pdf-zoom"><button id="zoomOut" type="button" aria-label="缩小 PDF" title="缩小 PDF（Ctrl+−）">−</button><input id="zoomValue" type="text" inputmode="decimal" maxlength="8" value="页宽" aria-label="PDF 缩放比例" title="输入 25%–1000% 并按回车；输入“页宽”恢复适合页宽；PDF 区域支持 Ctrl+滚轮及 Ctrl+＋/−"><button id="zoomIn" type="button" aria-label="放大 PDF" title="放大 PDF（Ctrl+＋）">＋</button></div></div></div><div id="stage"><div id="viewer" class="pdfViewer"></div><p id="missing">正在载入 PDF…</p></div><dialog id="settingsDialog"><form method="dialog"><header><strong>扫描件显示设置</strong><button value="close">×</button></header><label>亮度 <output id="brightnessValue"></output><input id="brightness" type="range" min="50" max="160"></label><label>背景色 <input id="paper" type="color"></label><label>文字色 <input id="ink" type="color"></label><label class="toggle"><input id="invert" type="checkbox">反色</label><footer><button id="reset" type="button">恢复默认</button><button value="close">完成</button></footer></form></dialog>`;

  function emit(name, ...args) {
    return listeners[name]?.(...args);
  }

  function bind(id, event, handler) {
    byId(id)?.addEventListener(event, handler);
  }

  function setupHeaderActions() {
    const header = document.querySelector('.site-header');
    const actions = header.querySelector('.actions');
    const menu = header.querySelector('.topActions');
    const panel = menu.querySelector('.menuPanel');
    const navigation = element('div', 'reader-navigation');
    navigation.append(byId('volumeSelect'), actions.querySelector('.action-group-page'));
    navigation.hidden = true;
    header.append(navigation);
    const nodes = [...actions.children];
    const slots = nodes.map(node => {
      const slot = document.createComment('toolbar action');
      node.before(slot);
      return slot;
    });
    let scheduled = false;
    const observer = new MutationObserver(schedule);
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        observer.disconnect();
        const focus = document.activeElement;
        const pdfTools = pdfFrame.querySelector('.pdf-tools');
        if (pdfTools && navigation.parentElement !== pdfTools) {
          pdfTools.append(navigation);
          navigation.hidden = false;
        }
        nodes.forEach((node, index) => slots[index].after(node));
        header.classList.remove('header-compact');
        const fits = () => actions.scrollWidth <= actions.clientWidth + 1 &&
          Math.max(...[...header.children].map(node => node.getBoundingClientRect().right)) <=
            header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight) + 1;
        if (!fits()) header.classList.add('header-compact');
        for (const node of [...nodes].reverse()) {
          if (node.parentElement !== actions) continue;
          if (fits()) break;
          panel.prepend(node);
        }
        if (focus instanceof HTMLElement && focus !== document.activeElement) {
          (panel.contains(focus) && !menu.open ? menu.querySelector('summary') : focus).focus({ preventScroll: true });
        }
        observer.observe(header, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
      });
    }
    menu.addEventListener('click', event => {
      if (event.target.closest('button')) menu.open = false;
    });
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { menu.open = false; menu.querySelector('summary').focus(); }
    });
    document.addEventListener('pointerdown', event => {
      if (!menu.contains(event.target)) menu.open = false;
    });
    new ResizeObserver(schedule).observe(header);
    const pdfToolsResize = new ResizeObserver(entries => {
      for (const { target } of entries) {
        target.classList.remove('compact-navigation');
        target.classList.toggle('compact-navigation', target.scrollWidth > target.clientWidth);
        pdfFrame.style.setProperty('--pdf-toolbar-height', `${target.getBoundingClientRect().height}px`);
      }
    });
    const watchPdfTools = () => {
      const toolbar = pdfFrame.querySelector('.pdf-tools');
      if (toolbar) { pdfToolsResize.observe(toolbar); schedule(); }
    };
    new MutationObserver(watchPdfTools).observe(pdfFrame, { childList: true });
    watchPdfTools();
    window.addEventListener('reader-toolbar-layout', schedule);
    document.fonts.ready.then(schedule);
    schedule();
  }
  setupHeaderActions();
  bind("full", "click", () => {
    (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen())
      .catch(error => notify(error.message, true));
  });
  document.addEventListener("fullscreenchange", () => {
    const fullscreen = Boolean(document.fullscreenElement);
    byId("full").textContent = fullscreen ? "退出全屏" : "全屏";
    byId("full").setAttribute("aria-pressed", String(fullscreen));
    requestAnimationFrame(() => pdfViewer?.update());
  });

  function setToc(open) {
    root.classList.toggle("toc-open", open);
    byId("tocBtn")?.setAttribute("aria-expanded", String(open));
  }

  function setTheme(dark) {
    body.classList.toggle("dark", dark);
    localStorage.setItem("readerDark", dark ? "1" : "0");
    const button = byId("darkBtn");
    if (button) button.textContent = dark ? "浅色" : "深色";
    emit("theme", dark);
    applyVisualTheme();
  }

  function setEditorScale(value) {
    editorScale = Math.min(1.6, Math.max(.8, Number(value) || 1));
    emit("editorScale", editorScale);
    const doc = visualFrame?.contentDocument;
    if (doc?.documentElement) doc.documentElement.style.zoom = editorScale;
    return editorScale;
  }

  function applyVisualTheme() {
    const doc = visualFrame?.contentDocument;
    if (!doc?.body) return;
    const dark = body.classList.contains("dark");
    doc.documentElement.style.colorScheme = dark ? "dark" : "light";
    doc.documentElement.style.setProperty("--reader-bg", dark ? "#121314" : "#ffffff");
    doc.documentElement.style.setProperty("--reader-ink", dark ? "#bbbebf" : "#202020");
    doc.documentElement.style.setProperty("--reader-link", dark ? "#48a0c7" : "#0069cc");
    doc.documentElement.style.zoom = editorScale;
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

  function setWorkspaceMode(mode, editorAvailable = true) {
    const readerOnly = mode === "reader";
    body.classList.toggle("reader-only", readerOnly);
    document.title = readerOnly ? "MEW 对照阅读器" : "MEW 对照阅读编辑器";
    document.querySelector(".brand-name").textContent = document.title;
    document.querySelector(".action-group-edit").hidden = readerOnly;
    byId("modeBtn").hidden = readerOnly;
    byId("combinedViewBtn").hidden = !readerOnly;
    const splitButton = byId("splitViewBtn");
    splitButton.disabled = !editorAvailable;
    splitButton.textContent = readerOnly ? "打开编辑器" : "双窗口";
    splitButton.title = editorAvailable
      ? (readerOnly ? "打开或重新聚焦联控编辑器窗口" : "用独立窗口打开编辑器，并把本窗口切换为纯阅读器")
      : "当前阅读器配置没有可用的本地编辑目录";
    splitter.hidden = readerOnly;
    window.dispatchEvent(new Event("reader-toolbar-layout"));
    requestAnimationFrame(() => {
      pdfViewer?.update();
      syncChromeMetrics();
    });
  }

  function notify(message, persistent = false) {
    byId("status").textContent = message || "";
    clearTimeout(statusTimer);
    if (message && !persistent) statusTimer = setTimeout(() => { byId("status").textContent = ""; }, 2600);
  }

  const pageButtons = [
    ["prevBtn", "hasPrevious", "Alt+←", " & 保存"], ["nextPageBtn", "hasNext", "Alt+→", " & 保存"],
    ["tagPrevBtn", "hasPrevious", "Prev", " · Auto Save"], ["tagNextPageBtn", "hasNext", "Next", " · Auto Save"]
  ];
  function setDirty(dirty) {
    byId("saveBtn").classList.toggle("dirty", dirty);
    byId("saveBtn").textContent = dirty ? "保存*" : "保存";
    for (const [id, , title, suffix] of pageButtons) {
      if (byId(id)) byId(id).title = title + (dirty ? suffix : "");
    }
  }

  function setHistoryButtons(canUndo, canRedo) {
    byId("undoBtn").disabled = !canUndo;
    byId("redoBtn").disabled = !canRedo;
  }

  function renderVolumes(volumes, selected) {
    const select = byId("volumeSelect");
    select.replaceChildren(...volumes.map(item => element("option", "", item.shortTitle, { value: item.id })));
    select.value = selected || "";
  }

  function renderToc(title, items) {
    byId("tocTitle").textContent = `${title}目录`;
    const list = byId("tocList");
    list.replaceChildren(...items.map((item) => {
      const li = element("li");
      li.style.setProperty("--level", item.level);
      const link = element("a", "", "", { href: "#" });
      link.dataset.page = item.page;
      link.append(element("span", "", item.page), item.title);
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
    for (const [id, enabled] of pageButtons) {
      if (byId(id)) byId(id).disabled = !view[enabled];
    }
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
    const tools = (items, kind) => items.map((item, index) => {
      const node = button(item.label, kind === "attr" ? "" : item.hotkey
        ? `Alt+${item.hotkey === "Enter" ? "Enter" : item.hotkey.toUpperCase()}` : item.title || item.label);
      node.dataset[kind] = index;
      return node;
    });
    const pageButton = (id, direction, label, title) => {
      const node = button(label, title, { id, className: "tag-page-button" });
      node.dataset.pageAdjacent = direction;
      return node;
    };
    byId("tagBar").replaceChildren(
      ...tools(tags, "tag"), element("span", "spacer"),
      ...tools(attrs, "attr"), element("span", "spacer"),
      pageButton("tagPrevBtn", -1, "← Prev", "Prev"),
      pageButton("tagNextPageBtn", 1, "Next →", "Next")
    );
  }

  function showVisual(source, options) {
    visualFrame.onload = () => {
      const doc = visualFrame.contentDocument;
      if (!doc?.body) return;
      doc.body.contentEditable = options.editable ? "true" : "false";
      doc.body.spellcheck = false;
      doc.body.addEventListener("input", () => emit("visualInput"));
      for (const [eventName, handlerName] of [["dblclick", "visualDoubleClick"], ["keydown", "keyDown"], ["click", "visualClick"]]) {
        doc.addEventListener(eventName, (event) => emit(handlerName, ...(eventName === "dblclick" ? [doc] : eventName === "click" ? [event, doc] : [event])));
      }
      const updateLinkMode = (event) => doc.documentElement.classList.toggle("reader-ctrl-link", event.ctrlKey || event.metaKey);
      for (const eventName of ["keydown", "keyup", "mousemove"]) doc.addEventListener(eventName, updateLinkMode);
      visualFrame.contentWindow.addEventListener("blur", () => doc.documentElement.classList.remove("reader-ctrl-link"));
      applyVisualTheme();
      window.dispatchEvent(new CustomEvent("reader-visual-ready", { detail: { document: doc } }));
      if (options.scroll) requestAnimationFrame(() => {
        doc.scrollingElement.scrollTop = options.scroll.top;
        doc.scrollingElement.scrollLeft = options.scroll.left;
      });
    };
    visualFrame.srcdoc = source;
  }

  const frameId = (id) => pdfFrame?.querySelector(`#${id}`);
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
  function scalePercent(input, min, max, restore, label = "") {
    const match = input.value.trim().match(/^(\d+(?:\.\d+)?)\s*%?$/);
    const percent = match ? Number(match[1]) : NaN;
    if (Number.isFinite(percent) && percent >= min && percent <= max) return percent / 100;
    restore();
    notify(`${label}缩放比例请输入 ${min}%–${max}%`, true);
  }

  function bindScaleInput(input, commit, restore) {
    input.addEventListener("change", commit);
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); commit(); input.select(); }
      else if (event.key === "Escape") { event.preventDefault(); restore(); input.blur(); }
    });
  }

  function applyPdfScaleInput() {
    const input = frameId("zoomValue");
    if (!input || !pdfViewer) return showPdfScaleValue();
    const value = input.value.trim().toLowerCase();
    if (["页宽", "适合页宽", "page-width", "auto"].includes(value)) {
      pdfViewer.currentScaleValue = "page-width";
      return;
    }
    const scale = scalePercent(input, 25, 1000, showPdfScaleValue, "PDF ");
    if (scale != null) pdfViewer.currentScaleValue = String(scale);
  }

  function changePdfScale(direction) {
    if (direction > 0) pdfViewer?.increaseScale();
    else if (direction < 0) pdfViewer?.decreaseScale();
  }

  function handlePdfScaleShortcut(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const wheel = event.type === "wheel";
    const insidePdf = event.target === pdfFrame || event.target.closest?.("#pdfFrame");
    if ((wheel && !insidePdf) || (!wheel && !insidePdf && !pdfShortcutActive)) return;
    const direction = wheel ? (event.deltaY < 0 ? 1 : event.deltaY > 0 ? -1 : 0)
      : ["Equal", "NumpadAdd"].includes(event.code) || event.key === "+" ? 1
        : ["Minus", "NumpadSubtract"].includes(event.code) || event.key === "-" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (wheel) pdfShortcutActive = true;
    changePdfScale(direction);
  }

  function pdfPageNumberForLabel(label) {
    const matches = pdfPageLabels?.map((value, index) => String(value) === String(label) ? index + 1 : 0).filter(Boolean);
    const current = pdfViewer?.currentPageNumber || matches?.[0];
    return matches?.reduce((best, page) => Math.abs(page - current) < Math.abs(best - current) ? page : best, matches[0]) || null;
  }
  function showPendingPdfPage() { const page = pdfPageNumberForLabel(pendingPdfOptions?.pageLabel); if (page) pdfViewer.currentPageNumber = page; }

  function imageObject(page, id) {
    if (typeof id !== "string") return null;
    const objects = id.startsWith("g_") ? page.commonObjs : page.objs;
    return objects.has(id) ? objects.get(id) : null;
  }

  function resolvedImage(page, image) {
    if (typeof image === "string") return imageObject(page, image);
    return typeof image?.data === "string" ? imageObject(page, image.data) : image;
  }

  async function originalPdfPageImage(pageNumber) {
    const page = await pdfViewer?.pdfDocument?.getPage(pageNumber);
    if (!page) throw new Error("PDF 页面尚未载入");
    const operators = await page.getOperatorList();
    const { OPS } = globalThis.pdfjsLib;
    const candidates = [];
    for (let index = 0; index < operators.fnArray.length; index += 1) {
      const operation = operators.fnArray[index];
      const args = operators.argsArray[index];
      let image = null;
      if (operation === OPS.paintInlineImageXObject || operation === OPS.paintImageMaskXObject) image = args[0];
      else if (operation === OPS.paintImageXObject || operation === OPS.paintImageXObjectRepeat) image = args[0];
      image = resolvedImage(page, image);
      if (!image?.width || !image?.height || (!image.bitmap && !image.data)) continue;
      candidates.push(image);
    }
    if (!candidates.length) throw new Error("当前 PDF 页没有可复制的扫描底图");
    return candidates.reduce((largest, image) => image.width * image.height > largest.width * largest.height ? image : largest);
  }

  function pdfImagePng(image) {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (image.bitmap) context.drawImage(image.bitmap, 0, 0);
    else {
      const pixels = context.createImageData(image.width, image.height);
      const target = pixels.data;
      const { ImageKind } = globalThis.pdfjsLib;
      if (image.kind === ImageKind.RGBA_32BPP) target.set(image.data);
      else if (image.kind === ImageKind.RGB_24BPP) {
        for (let source = 0, dest = 0; source < image.data.length; source += 3, dest += 4) {
          target[dest] = image.data[source]; target[dest + 1] = image.data[source + 1];
          target[dest + 2] = image.data[source + 2]; target[dest + 3] = 255;
        }
      } else if (image.kind === ImageKind.GRAYSCALE_1BPP) {
        const rowBytes = Math.ceil(image.width / 8);
        for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
          const bit = image.data[y * rowBytes + (x >> 3)] >> (7 - (x & 7)) & 1;
          const value = (bit ^ Boolean(image.inverseDecode)) ? 255 : 0;
          const dest = (y * image.width + x) * 4;
          target[dest] = target[dest + 1] = target[dest + 2] = value; target[dest + 3] = 255;
        }
      } else throw new Error("当前扫描底图的像素格式不受支持");
      context.putImageData(pixels, 0, 0);
    }
    return new Promise((resolve, reject) => canvas.toBlob(
      blob => blob ? resolve({ blob, width: image.width, height: image.height }) : reject(new Error("扫描底图 PNG 编码失败")),
      "image/png"
    ));
  }

  function copyOriginalPdfImage(event) {
    const pageNumber = pdfContextPageNumber;
    pdfContextPageNumber = null;
    if (!pageNumber) return;
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      notify("当前浏览器不支持把 PDF 原底图写入剪贴板", true);
      return;
    }
    event.preventDefault();
    const result = originalPdfPageImage(pageNumber).then(pdfImagePng);
    navigator.clipboard.write([new ClipboardItem({ "image/png": result.then(value => value.blob) })])
      .then(async () => {
        const { width, height } = await result;
        notify(`已复制 PDF 原底图（${width} × ${height}）`);
      })
      .catch(error => notify(`复制 PDF 原底图失败：${error.message}`, true));
  }

  async function ensurePdfRuntime() {
    if (pdfRuntimePromise) return pdfRuntimePromise;
    pdfRuntimePromise = (async () => {
      const pdfjs = await import("/vendor/pdfjs/build/pdf.mjs"); globalThis.pdfjsLib = pdfjs;
      const viewerModule = await import("/vendor/pdfjs/web/pdf_viewer.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.mjs";
      const eventBus = new viewerModule.EventBus(); pdfLinkService = new viewerModule.PDFLinkService({ eventBus });
      pdfViewer = new viewerModule.PDFViewer({
        container: frameId("stage"), viewer: frameId("viewer"), eventBus, linkService: pdfLinkService,
        imageResourcesPath: "/vendor/pdfjs/web/images/", imagesRightClickMinSize: 1
      });
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
    pdfFrame.innerHTML = PDF_DIRECT_HTML;
    window.dispatchEvent(new Event("reader-toolbar-layout"));
    pdfFrame.addEventListener("contextmenu", event => {
      const page = event.target.closest?.(".pdfViewer .page");
      pdfContextPageNumber = event.target instanceof HTMLCanvasElement && page ? Number(page.dataset.pageNumber) : null;
    }, true);
    document.addEventListener("copy", copyOriginalPdfImage, true);
    document.addEventListener("pointerdown", (event) => {
      pdfShortcutActive = pdfFrame.contains(event.target);
      if (event.button !== 2) pdfContextPageNumber = null;
    }, true);
    document.addEventListener("wheel", handlePdfScaleShortcut, { capture: true, passive: false });
    document.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") pdfContextPageNumber = null;
      handlePdfScaleShortcut(event);
    }, true);
    (async () => {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(PDF_SETTINGS_KEY) || "{}"); } catch { localStorage.removeItem(PDF_SETTINGS_KEY); }
      const legacy = {};
      if (localStorage.getItem("readerPdfHorizontal") != null) legacy.horizontal = localStorage.getItem("readerPdfHorizontal") === "1";
      if (localStorage.getItem("readerImageInverted") != null) legacy.invert = localStorage.getItem("readerImageInverted") === "1";
      if (localStorage.getItem("readerPdfScaleValue")) legacy.scale = localStorage.getItem("readerPdfScaleValue");
      saved = { ...legacy, ...saved };
      try { pdfSettings = normalizedPdfSettings({ ...(await fetch("/api/reader/settings").then((r) => r.ok ? r.json() : {})), ...saved }); } catch { pdfSettings = normalizedPdfSettings(saved); }
      applyPdfSettings();
      frameId("zoomIn").onclick = () => changePdfScale(1); frameId("zoomOut").onclick = () => changePdfScale(-1);
      bindScaleInput(frameId("zoomValue"), applyPdfScaleInput, showPdfScaleValue);
      frameId("zoomValue").ondblclick = () => { if (pdfViewer) pdfViewer.currentScaleValue = "page-width"; };
      frameId("direction").onclick = () => changePdfSettings({ horizontal: !pdfSettings.horizontal }); frameId("settings").onclick = () => frameId("settingsDialog").showModal(); frameId("brightness").oninput = (event) => changePdfSettings({ brightness: event.target.value }); frameId("paper").oninput = (event) => changePdfSettings({ paper: event.target.value }); frameId("ink").oninput = (event) => changePdfSettings({ ink: event.target.value }); frameId("invert").onchange = (event) => changePdfSettings({ invert: event.target.checked }); frameId("reset").onclick = () => changePdfSettings(PDF_DEFAULTS);
      if (pendingPdfOptions) setPdf(pendingPdfOptions);
    })().catch((error) => notify(error.message, true));
  }

  function init(handlers) {
    Object.assign(listeners, handlers);
    if (initialized) return;
    initialized = true;
    initPdfFrame();
    for (const action of ["mode", "save", "undo", "redo", "splitView", "combinedView", "find"]) {
      bind(`${action}Btn`, "click", () => emit(action));
    }
    bind("volumeSelect", "change", (event) => emit("volume", event.target.value));
    bind("pageForm", "submit", (event) => {
      event.preventDefault();
      const input = byId("pageInput");
      const page = Number(input.value);
      input.blur();
      emit("page", page);
    });
    for (const [id, direction] of [["prevBtn", -1], ["nextPageBtn", 1]]) bind(id, "click", () => emit("adjacent", direction));
    bind("tocBtn", "click", () => setToc(!root.classList.contains("toc-open")));
    for (const id of ["tocClose", "tocBackdrop"]) bind(id, "click", () => setToc(false));
    bind("tocList", "click", (event) => {
      const link = event.target.closest("[data-page]");
      if (!link) return;
      event.preventDefault();
      setToc(false);
      emit("page", Number(link.dataset.page));
    });
    bind("darkBtn", "click", () => setTheme(!body.classList.contains("dark")));
    bind("tagBar", "click", (event) => {
      for (const [attribute, action] of [["pageAdjacent", "adjacent"], ["tag", "tag"], ["attr", "attr"]]) {
        const node = event.target.closest("button");
        if (node && attribute in node.dataset) emit(action, Number(node.dataset[attribute]));
      }
    });
    document.addEventListener("keydown", (event) => emit("keyDown", event));
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
  let dragging = false;
  let currentWidth;
  const setWidth = percent => {
    currentWidth = Math.min(75, Math.max(25, percent));
    grid.style.setProperty("--left-pane", `${currentWidth}%`);
    splitter.setAttribute("aria-valuenow", String(Math.round(currentWidth)));
  };
  setWidth(savedWidth >= 25 && savedWidth <= 75 ? savedWidth : 54);
  const resizeTo = clientX => {
    const bounds = grid.getBoundingClientRect();
    setWidth((clientX - bounds.left) / bounds.width * 100);
  };

  splitter.addEventListener("pointerdown", (event) => {
    if (matchMedia("(max-width: 850px)").matches) return;
    dragging = true;
    splitter.classList.add("dragging");
    body.classList.add("resizing");
    splitter.setPointerCapture?.(event.pointerId);
    resizeTo(event.clientX);
    event.preventDefault();
  });

  splitter.addEventListener("pointermove", (event) => {
    if (dragging) resizeTo(event.clientX);
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
    setWidth(54);
    localStorage.removeItem("readerLeftPane");
  });

  splitter.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const step = (event.shiftKey ? 5 : 2) * (event.key === "ArrowRight" ? 1 : -1);
    setWidth(event.key === "Home" ? 25 : event.key === "End" ? 75 : currentWidth + step);
    localStorage.setItem("readerLeftPane", currentWidth.toFixed(2));
  });

  const chromeNodes = [document.querySelector(".site-header"), document.querySelector(".page-footer")];
  const chromeHeights = (fallback = 0) => ({
    header: Math.round(chromeNodes[0]?.getBoundingClientRect().height || fallback),
    footer: Math.round(chromeNodes[1]?.getBoundingClientRect().height || 0)
  });
  const syncChromeMetrics = () => {
    for (const [name, height] of Object.entries(chromeHeights(64))) root.style.setProperty(`--app-${name}-height`, `${height}px`);
    window.dispatchEvent(new Event("reader-chrome-resize"));
  };
  const chromeResizeObserver = new ResizeObserver(syncChromeMetrics);
  chromeNodes.filter(Boolean).forEach(node => chromeResizeObserver.observe(node));
  syncChromeMetrics();

  window.ReaderUI = {
    init, notify, setDirty, setHistoryButtons, renderVolumes, renderToc, renderNavigation, renderTools,
    setMode, setWorkspaceMode, setToc, setPdf, applyVisualTheme, showVisual, setEditorScale,
    byId, editorScale: () => editorScale, isDark: () => body.classList.contains("dark"),
    getVisualDocument: () => visualFrame.contentDocument
  };

/* 编辑工具面板由 index.html 与 reader.html 共用同一个控制器。 */
window.MewTagPanel?.mount({
  content: "#tagBar",
  host: ".text-pane",
  storageKey: "readerDockPanels.v1",
  headerSelector: ".site-header",
  footerSelector: ".page-footer",
  setEditorScale: scale => window.ReaderUI?.setEditorScale(scale),
  editorSelector: "#sourcePane,#monacoEditor,#visualEditor",
  editorReadyEvent: "reader-visual-ready",
  layoutEvents: ["reader-mode-change"],
  onLayout: () => window.dispatchEvent(new Event("reader-panel-layout"))
});
})();
