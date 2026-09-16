(() => {
  "use strict";
  const core = window.MewEditorCore;
  if (!core) throw new Error("MewEditorCore 未载入");
  const tagPanel = window.MewTagPanel;
  if (!tagPanel) throw new Error("MewTagPanel 未载入");
  const { DocumentModel, createChannel } = core;
  const { tags, attrs, tagMap, blockTagNames } = tagPanel;
  const blockSelector = [...blockTagNames].join(",");

  const ui = window.ReaderUI;
  if (!ui) throw new Error("ReaderUI 未载入");

  const initialParams = new URLSearchParams(location.search);
  const requestedSession = /^[\w-]{1,128}$/.test(initialParams.get("sync") || "") ? initialParams.get("sync") : "";

  const state = {
    config: null,
    volume: null,
    page: null,
    document: new DocumentModel({ editable: false }),
    mode: "source",
    workspaceMode: initialParams.get("view") === "reader" ? "reader" : "combined",
    syncSession: requestedSession,
    navigationRevision: 0,
    pendingPdfNavigation: null
  };
  let currentPdfPage = null;
  let directoryRefreshTimer;
  let directoryRefreshRevision = 0;
  let syncChannel = null;
  let pairedWindow = null;
  let locateRevision = 0;
  const editorPathCache = new Map();

  async function api(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function editorPathForPage(volume = state.volume, page = state.page) {
    const key = `${volume}:${page}`;
    if (editorPathCache.has(key)) return editorPathCache.get(key);
    const link = await api(`/api/reader/link/${encodeURIComponent(volume)}/${page}`);
    editorPathCache.set(key, link.path);
    return link.path;
  }

  async function announceReaderPage() {
    if (!syncChannel || state.workspaceMode !== "reader" || state.page == null) return;
    const volume = state.volume;
    const page = state.page;
    try {
      const editorPath = await editorPathForPage(volume, page);
      if (volume !== state.volume || page !== state.page || !syncChannel) return;
      syncChannel.postMessage({
        source: "reader", type: "reader-page", volume, page, path: editorPath
      });
    } catch (error) {
      ui.notify(`当前页无法在独立编辑器中打开：${error.message}`, true);
    }
  }

  async function receiveSyncMessage(message) {
    if (!message || message.source !== "editor" || state.workspaceMode !== "reader") return;
    if (message.type === "editor-ready") return announceReaderPage();
    if (message.type !== "editor-page" || !message.path) return;
    const revision = ++locateRevision;
    try {
      const target = await api(`/api/reader/locate?path=${encodeURIComponent(message.path)}`);
      if (revision !== locateRevision) return;
      if (target.volume !== state.volume || target.page !== state.page) await navigate(target.volume, target.page);
    } catch {
      // Ordinary files may remain open in index.html without moving the PDF.
    }
  }

  function openSyncChannel() {
    syncChannel?.close();
    syncChannel = state.syncSession ? createChannel(state.syncSession, receiveSyncMessage) : null;
    syncChannel?.postMessage({ source: "reader", type: "reader-ready" });
  }

  function newSession() {
    return (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^\w-]/g, "");
  }

  async function ensureEditorRuntime() {
    const monaco = await core.loadMonaco();
    ui.initMonaco(monaco);
    ui.renderTools(tags, attrs);
    updateHistoryButtons();
  }

  function currentVolume() {
    return state.config?.volumes.find((item) => item.id === state.volume);
  }

  function markDirty() {
    ui.setDirty(state.document.dirty);
  }

  function updateHistoryButtons() {
    ui.setHistoryButtons(ui.canUndo(), ui.canRedo());
  }

  function currentSource() {
    if (state.mode !== "visual") return state.document.textFromEditor(ui.getSource());
    const live = ui.getVisualDocument();
    if (!live?.body) return state.document.content;
    const parsed = new DOMParser().parseFromString(state.document.content, "text/html");
    // Parsing changes source formatting even without an edit. Compare bodies
    // in the same DOM representation before serializing a visual change.
    if (parsed.body.innerHTML === live.body.innerHTML) return state.document.content;
    parsed.body.innerHTML = live.body.innerHTML;
    parsed.head.querySelectorAll("[data-reader-editor]").forEach((node) => node.remove());
    const doctype = parsed.doctype ? `<!DOCTYPE ${parsed.doctype.name}>` : "<!doctype html>";
    return `${doctype}\n${parsed.documentElement.outerHTML}`;
  }

  function updateWorkingCopy(source = currentSource()) {
    source = state.document.textFromEditor(source);
    state.document.update(source);
    if (state.mode === "visual") ui.setSource(source, true);
    markDirty();
    updateHistoryButtons();
    return source;
  }

  function restoreHistory(method, action) {
    const visual = ui.getVisualDocument();
    const scroll = state.mode === "visual"
      ? { top: visual?.scrollingElement?.scrollTop || 0, left: visual?.scrollingElement?.scrollLeft || 0 }
      : null;
    ui[`${method}Source`]();
    updateWorkingCopy(ui.getSource());
    if (state.mode === "visual") renderVisual(scroll);
    else ui.focusSource();
    ui.notify(`已${action}`);
  }

  const undo = () => restoreHistory("undo", "撤销");
  const redo = () => restoreHistory("redo", "重做");

  function injectEditorDocument(source) {
    const base = `<base href="/api/reader/resource/${encodeURIComponent(state.volume)}/">`;
    const style = '<style data-reader-editor>html{background:var(--reader-bg,#fff)}body{max-width:760px;margin:0 auto;padding:40px 48px 80px;background:var(--reader-bg,#fff);color:var(--reader-ink,#251f1b);caret-color:currentColor;font:18px/1.75 Georgia,"Noto Serif SC","SimSun",serif;outline:none}img{max-width:100%;height:auto}a{color:var(--reader-link,#8f2923)}.reader-ctrl-link a[href]{text-decoration:underline;cursor:pointer}body:focus{box-shadow:inset 0 0 0 2px #9d2b2430}</style>';
    if (/<head\b[^>]*>/i.test(source)) return source.replace(/<head\b[^>]*>/i, (head) => `${head}${base}${style}`);
    if (/<html\b[^>]*>/i.test(source)) return source.replace(/<html\b[^>]*>/i, (html) => `${html}<head>${base}${style}</head>`);
    return `<!doctype html><html><head>${base}${style}</head><body>${source}</body></html>`;
  }

  function renderVisual(scroll = null) {
    ui.showVisual(injectEditorDocument(state.document.content), { editable: state.document.editable, scroll });
  }

  function setMode(mode = state.mode === "visual" ? "source" : "visual", { resetSourceScroll = false } = {}) {
    if (state.page == null || state.workspaceMode === "reader") return;
    const next = mode === "visual" ? "visual" : "source";
    if (next !== state.mode) updateWorkingCopy();
    state.mode = next;
    ui.setMode(next);
    if (next === "source") {
      ui.setSource(state.document.content);
      if (resetSourceScroll) ui.setSourceScroll({ top: 0, left: 0 });
      ui.focusSource();
    } else {
      renderVisual();
    }
    updateHistoryButtons();
    syncUrl();
  }

  function syncUrl() {
    if (state.volume == null || state.page == null) return;
    const params = new URLSearchParams(location.search);
    const paired = state.workspaceMode === "reader" && state.syncSession;
    for (const [key, value] of Object.entries({ volume: state.volume, page: state.page, mode: state.mode,
      view: paired ? "reader" : null, sync: paired || null })) {
      if (value == null) params.delete(key);
      else params.set(key, value);
    }
    history.replaceState(null, "", `${location.pathname}?${params}`);
  }

  async function loadPageOrPrevious(volume, requestedPage) {
    const candidates = volume.pages
      .filter((page) => page <= requestedPage)
      .sort((a, b) => b - a);

    for (const page of candidates) {
      try {
        const url = `/api/reader/page/${encodeURIComponent(volume.id)}/${page}`;
        const data = await api(url);
        const document = new DocumentModel({
          ...data,
          read: () => api(url),
          write: snapshot => api(url, {
            method: "PUT", headers: { "content-type": "application/json" },
            body: JSON.stringify(snapshot)
          })
        });
        return { page, document, editorPath: data.path || null };
      } catch (error) {
        // Missing local/remote files fall back to the previous available page.
        if (!/(ENOENT|no such file|远程页面读取失败)/i.test(error?.message || "")) throw error;
      }
    }
    return null;
  }

  function renderNavigation() {
    const volume = currentVolume();
    const index = volume.pages.indexOf(state.page);
    const chapter = (volume.toc || []).findLast(item => item.page <= state.page);
    ui.renderNavigation({
      chapterTitle: chapter?.title || volume.title,
      chapterPage: chapter?.page,
      pageContext: `${volume.shortTitle} · 第 ${state.page} 页`,
      pageTotal: volume.pages.length,
      pageIndex: index + 1,
      page: state.page,
      volume: state.volume,
      hasPrevious: index > 0,
      hasNext: index < volume.pages.length - 1,
      editable: state.workspaceMode !== "reader" && state.document.editable
    });
  }

  async function navigate(targetVolume, targetPage, force = false, pdfOrigin = null) {
    // Any local/PDF navigation supersedes an older editor-path lookup that may
    // still be in flight; otherwise a late dirty-state announcement can jump back.
    ++locateRevision;
    if (!pdfOrigin) state.pendingPdfNavigation = null;
    if (state.workspaceMode !== "reader" && !force && state.document.dirty && !(await save())) return false;
    const volume = state.config.volumes.find((item) => item.id === String(targetVolume));
    if (!volume) return false;
    const requestedPage = Number(targetPage);
    if (!Number.isFinite(requestedPage)) return false;
    const revision = ++state.navigationRevision;
    const readerOnly = state.workspaceMode === "reader";
    const previousDocument = state.document;
    const workingCopyRevision = previousDocument.revision;
    try {
      const candidate = volume.pages.filter((page) => page <= requestedPage).at(-1);
      const loaded = readerOnly
        ? candidate == null ? null : { page: candidate, document: new DocumentModel({ editable: false }), editorPath: null }
        : await loadPageOrPrevious(volume, requestedPage);
      if (!loaded) throw new Error(`第 ${requestedPage} 页及之前没有可用的网页文件`);
      if (revision !== state.navigationRevision) return true;
      if (!readerOnly && (previousDocument !== state.document || workingCopyRevision !== state.document.revision || state.document.dirty)) {
        if (!(await save())) return false;
        if (revision !== state.navigationRevision) return true;
        return navigate(volume.id, requestedPage, true, pdfOrigin);
      }

      const { page, document, editorPath } = loaded;
      const volumeChanged = state.volume !== volume.id;
      state.volume = volume.id;
      state.page = page;
      if (editorPath) editorPathCache.set(`${volume.id}:${page}`, editorPath);
      state.document = document;
      if (!readerOnly) {
        ui.setSourceEditable(document.editable);
        ui.setSource(document.content);
        markDirty();
        setMode(state.mode, { resetSourceScroll: true });
      } else syncUrl();
      if (volumeChanged) ui.renderToc(volume.shortTitle, volume.toc);
      renderNavigation();

      // PDF 发起的翻页已经处于正确的物理页，不反向驱动 PDF。
      // 左侧网页发起导航时才定位 PDF；UI 会在重复标签中选择离当前物理页最近的一项。
      if (!pdfOrigin) {
        currentPdfPage = { volume: volume.id, pageLabel: String(page) };
        ui.setPdf({ url: volume.pdfUrl, pageLabel: String(page) })
          .catch((error) => ui.notify(`PDF 载入失败：${error.message}`, true));
      }
      if (page !== requestedPage) ui.notify(`第 ${requestedPage} 页暂无网页文件，已${readerOnly ? "定位" : "显示"}上一可用页 ${page}`);
      else if (!readerOnly && !document.editable) ui.notify("远程页面：只读");
      if (readerOnly) announceReaderPage();
      return true;
    } catch (error) {
      if (revision === state.navigationRevision) ui.notify(error.message, true);
      return false;
    }
  }

  async function save(options = {}) {
    const followPdf = options.followPdf !== false;
    if (state.page == null) return true;
    updateWorkingCopy();
    const document = state.document;
    try {
      await document.saveUntilClean();
      if (document === state.document) markDirty();
      ui.notify("已保存");
      const pending = followPdf && document === state.document && !document.dirty
        ? state.pendingPdfNavigation : null;
      if (pending) {
        state.pendingPdfNavigation = null;
        if (pending.volume === state.volume && pending.page !== state.page) {
          return navigate(pending.volume, pending.page, true, pending.pdfOrigin);
        }
      }
      return true;
    } catch (error) {
      ui.notify(`保存失败：${error.message}`, true);
      return false;
    }
  }

  function editorUrl(path) {
    const url = new URL("index.html", location.href);
    url.search = "";
    url.searchParams.set("readerSession", state.syncSession);
    if (path) url.searchParams.set("file", path);
    return url.href;
  }

  function openEditorWindow() {
    const brands = navigator.userAgentData?.brands || [];
    const chromium = brands.some(({ brand }) => /Chromium|Google Chrome|Microsoft Edge/i.test(brand))
      || /\b(?:Chrome|Chromium|Edg|OPR)\/\d/i.test(navigator.userAgent);
    const name = `mew-editor-${state.syncSession}`;
    // Chromium honors the `popup` feature as a minimal-chrome, app-style
    // window. Other engines keep their normal named-window behavior.
    return chromium ? window.open("", name, "popup=yes") : window.open("", name);
  }

  async function openPairedEditor(popup) {
    try {
      const volume = state.volume;
      const page = state.page;
      const editorPath = await editorPathForPage(volume, page);
      if (volume !== state.volume || page !== state.page) return openPairedEditor(popup);
      const url = editorUrl(editorPath);
      const params = new URL(popup.location.href).searchParams;
      if (popup.location.pathname.endsWith("/index.html") && params.get("readerSession") === state.syncSession) popup.focus();
      else popup.location.replace(url);
      pairedWindow = popup;
      announceReaderPage();
      return true;
    } catch (error) {
      popup.close();
      ui.notify(`无法打开独立编辑器：${error.message}`, true);
      return false;
    }
  }

  async function enterSplitView() {
    if (!state.config?.editorAvailable) return ui.notify("当前阅读器配置没有可用的本地编辑目录", true);
    if (!state.syncSession) state.syncSession = newSession();
    const popup = pairedWindow && !pairedWindow.closed
      ? pairedWindow
      : openEditorWindow();
    if (!popup) return ui.notify("浏览器阻止了编辑器窗口，请允许此站点打开弹出窗口", true);
    if (state.workspaceMode === "reader") return openPairedEditor(popup);
    if (state.document.dirty && !(await save({ followPdf: false }))) {
      popup.close();
      return false;
    }
    state.workspaceMode = "reader";
    state.document = new DocumentModel({ editable: false });
    state.pendingPdfNavigation = null;
    ui.setWorkspaceMode("reader", true);
    openSyncChannel();
    renderNavigation();
    syncUrl();
    if (!(await openPairedEditor(popup))) return false;
    // Reload through the pure-reader entry path so this window releases the
    // already-created Monaco instance instead of merely hiding its DOM.
    location.reload();
    return true;
  }

  function restoreCombinedView() {
    syncChannel?.postMessage({ source: "reader", type: "reader-detached" });
    syncChannel?.close();
    syncChannel = null;
    state.syncSession = "";
    state.workspaceMode = "combined";
    ui.setWorkspaceMode("combined", state.config?.editorAvailable);
    syncUrl();
    location.reload();
  }

  let refreshing = false;
  async function refreshLocalFile() {
    if (state.workspaceMode === "reader" || refreshing || document.hidden || state.page == null || !state.document.editable) return;
    refreshing = true;
    const current = state.document;
    try {
      const result = await current.refresh();
      if (current !== state.document) return;
      if (result === "conflict") ui.notify("文件已在外部修改；本地未保存内容已保留，请保存副本后重新载入", true);
      else if (result === "updated") {
        ui.setSource(current.content);
        if (state.mode === "visual") renderVisual();
        markDirty();
        updateHistoryButtons();
        ui.notify("已从本地文件刷新");
      } else if (result === "saved") markDirty();
    } catch (error) {
      ui.notify(`本地文件刷新失败：${error.message}`, true);
    } finally { refreshing = false; }
  }

  function openVisualLink(event, doc) {
    const link = event.target.closest?.("a[href]");
    if (!link || !(event.ctrlKey || event.metaKey)) return;
    const href = link.getAttribute("href");
    event.preventDefault();
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      const target = doc.getElementById(id) || doc.getElementsByName(id)[0];
      if (target) {
        target.scrollIntoView({ block: "center", inline: "nearest" });
        ui.notify(`已跳转到 ${href}`);
      } else ui.notify(`未找到锚点：${href}`);
      return;
    }
    window.open(new URL(href, doc.baseURI).href, "_blank", "noopener");
  }

  function trimVisualWordSelection(doc) {
    const selection = doc.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const text = range.toString();
    if (!text || !text.trim()) return;
    const leading = text.length - text.trimStart().length;
    const trailing = text.length - text.trimEnd().length;
    if (!leading && !trailing) return;
    const root = range.commonAncestorContainer;
    const nodes = root.nodeType === doc.defaultView.Node.TEXT_NODE ? [root] : [];
    if (!nodes.length) {
      const walker = doc.createTreeWalker(root, doc.defaultView.NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        if (range.intersectsNode(node)) nodes.push(node);
      }
    }
    for (const [edge, count, ordered] of [["Start", leading, nodes], ["End", trailing, [...nodes].reverse()]]) {
      let remaining = count;
      const start = edge === "Start";
      for (const node of ordered) {
        if (!remaining) break;
        const offset = start
          ? node === range.startContainer ? range.startOffset : 0
          : node === range.endContainer ? range.endOffset : node.textContent.length;
        const cut = Math.min(remaining, start ? node.textContent.length - offset : offset);
        range[`set${edge}`](node, offset + (start ? cut : -cut));
        remaining -= cut;
      }
    }
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function elementTagInfo(element) {
    if (!element) return null;
    const name = element.tagName.toLowerCase();
    const align = (element.getAttribute("align") || "").toLowerCase();
    return { name, kind: name === "p" && align ? `p:${align}` : name, block: blockTagNames.has(name) };
  }

  function selectVisualNodes(first, last, doc, contents = false) {
    if (!first || !last) return;
    const range = doc.createRange();
    if (contents) range.selectNodeContents(first);
    else {
      range.setStartBefore(first);
      range.setEndAfter(last);
    }
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function insertVisual(tag) {
    const doc = ui.getVisualDocument();
    if (!doc?.body || !state.document.editable) return;
    const template = doc.createElement("template");
    template.innerHTML = tag.open;
    const info = elementTagInfo(template.content.firstElementChild);
    const selection = doc.getSelection();
    const anchor = selection?.anchorNode?.nodeType === doc.defaultView.Node.ELEMENT_NODE
      ? selection.anchorNode : selection?.anchorNode?.parentElement;
    const container = info && anchor?.closest?.(info.block ? blockSelector : info.name);
    let action = "已插入";
    if (container && doc.body.contains(container)) {
      const remove = elementTagInfo(container).kind === info.kind;
      const replacement = remove ? doc.createDocumentFragment() : template.content.firstElementChild;
      if (!replacement) return;
      const first = container.firstChild, last = container.lastChild;
      replacement.append(...container.childNodes);
      container.replaceWith(replacement);
      if (remove) selectVisualNodes(first, last, doc);
      else selectVisualNodes(replacement, replacement, doc, true);
      action = remove ? "已移除" : "已替换";
    } else {
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (!range) return;
      const holder = doc.createElement("div");
      holder.append(range.cloneContents());
      template.innerHTML = tag.open + holder.innerHTML + tag.close;
      const fragment = template.content;
      const inserted = [...fragment.childNodes];
      range.deleteContents();
      range.insertNode(fragment);
      selectVisualNodes(inserted[0], inserted.at(-1), doc);
    }
    updateWorkingCopy();
    doc.body.focus();
    return action;
  }

  function insertSourceTag(tag) {
    const { start, end } = ui.getSourceSelection();
    const source = ui.getSource();
    const operation = ui.applySourceTag(tag);
    const removed = operation.text.length < operation.end - operation.start;
    const wrapped = tag.open + source.slice(start, end) + tag.close;
    const replaced = !removed && operation.text !== wrapped;
    return removed ? "已移除" : replaced ? "已替换" : "已插入";
  }

  function applySourceEdit(text, start, end, selectStart, selectEnd = selectStart) {
    ui.replaceSourceRange(text, start, end, "select");
    ui.setSourceSelection(selectStart, selectEnd);
    ui.focusSource();
  }

  function editTag(tag) {
    const action = state.mode === "visual" ? insertVisual(tag) : insertSourceTag(tag);
    if (action) ui.notify(`${action} ${tag.label}`);
  }

  function toggleFind() {
    if (state.mode !== "source") setMode("source");
    ui.focusSource();
    ui.toggleFind(true);
  }

  function adjacent(direction) {
    const pages = currentVolume()?.pages || [];
    const index = pages.indexOf(state.page);
    if (pages[index + direction] != null) navigate(state.volume, pages[index + direction]);
  }

  function handleKeyDown(event) {
    const key = event.key.toLowerCase();
    const command = event.ctrlKey || event.metaKey;
    const formField = event.target.matches?.("input, textarea, select");
    const commandAction = command && state.workspaceMode !== "reader" && (
      key === "s" ? save
        : (key === "f" || key === "h") && state.mode !== "source" ? toggleFind
          : !formField && !ui.hasSourceTextFocus() && (key === "z" || key === "y")
            ? (key === "y" || event.shiftKey ? redo : undo) : null);
    if (commandAction) {
      event.preventDefault();
      return commandAction();
    }
    if (event.key === "Escape") ui.setToc(false);
    if (formField) return;
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const editableTarget = event.target.matches?.("textarea,[contenteditable]") || event.target.isContentEditable || event.target.closest?.(".monaco-editor");
    if (event.altKey && !command) {
      const tag = tagMap.get(key);
      if (direction || tag) event.preventDefault();
      if (direction) adjacent(direction);
      else if (tag) editTag(tag);
    } else if (direction && !editableTarget) adjacent(direction);
  }

  async function changeVolume(id) {
    const volume = state.config.volumes.find((item) => item.id === id);
    if (!volume || !(await navigate(volume.id, volume.pages[0]))) renderNavigation();
  }

  async function init() {
    ui.init({
      mode: () => setMode(), save, undo, redo, volume: changeVolume,
      splitView: enterSplitView, combinedView: restoreCombinedView,
      page: (page) => navigate(state.volume, page), adjacent,
      tag: (index) => editTag(tags[index]),
      attr: (index) => {
        if (state.mode === "visual") return ui.notify("属性按钮请在源代码模式使用");
        const attr = attrs[index], { start, end } = ui.getSourceSelection();
        const selected = ui.getSource().slice(start, end);
        applySourceEdit(attr.text + selected, start, end, start + (attr.cursorOffset ?? attr.text.length + selected.length));
      },
      sourceInput: () => updateWorkingCopy(ui.getSource()),
      visualInput: () => updateWorkingCopy(),
      visualDoubleClick: trimVisualWordSelection,
      visualClick: openVisualLink,
      pdfPageChange: ({ pageNumber, pageLabel }) => {
        updateWorkingCopy();
        const volume = currentVolume();
        if (!volume) return;
        currentPdfPage = { volume: volume.id, pageNumber, pageLabel };
        const prefix = String(pageLabel ?? "").match(/^(\d+)/)?.[1];
        if (!prefix) return;
        const page = Number(prefix);
        if (state.document.dirty) {
          state.pendingPdfNavigation = {
            volume: volume.id,
            page,
            pdfOrigin: { pageNumber, pageLabel }
          };
          ui.notify("网页有未保存修改；保存后将切换到当前 PDF 页");
          return;
        }
        state.pendingPdfNavigation = null;
        navigate(volume.id, page, false, { pageNumber, pageLabel });
      },
      find: toggleFind,
      historyChanged: updateHistoryButtons,
      keyDown: handleKeyDown,
      beforeUnload: (event) => {
        if (state.workspaceMode === "reader" || !state.document.dirty) return;
        event.preventDefault();
        event.returnValue = "";
      }
    });
    try {
      if (state.workspaceMode !== "reader") await ensureEditorRuntime();
      state.config = await api("/api/reader/config");
      const requestedMode = initialParams.get("mode");
      if (requestedMode === "source" || requestedMode === "visual") state.mode = requestedMode;
      if (state.workspaceMode === "reader" && !state.syncSession) state.syncSession = newSession();
      ui.setWorkspaceMode(state.workspaceMode, state.config.editorAvailable);
      if (state.workspaceMode === "reader") openSyncChannel();
      const firstVolume = state.config.volumes.find((item) => item.id === initialParams.get("volume")) || state.config.volumes[0];
      if (!firstVolume) throw new Error("配置中没有找到包含 HTML 页面的卷册");
      ui.renderVolumes(state.config.volumes, firstVolume.id);
      await navigate(firstVolume.id, Number(initialParams.get("page")) || firstVolume.pages[0], true);
    } catch (error) {
      ui.renderNavigation({
        chapterTitle: "载入失败", chapterPage: null, pageContext: "", pageTotal: "", pageIndex: "",
        page: "", volume: "", hasPrevious: false, hasNext: false, editable: false
      });
      ui.notify(error.message, true);
    }
  }

  async function refreshDirectory() {
    const revision = ++directoryRefreshRevision;
    const config = await api("/api/reader/config");
    if (revision !== directoryRefreshRevision || !state.config) return;
    state.config = config;
    editorPathCache.clear();
    ui.renderVolumes(config.volumes, state.volume);
    renderNavigation();
    const origin = currentPdfPage;
    if (!origin || origin.volume !== state.volume) return;
    const prefix = String(origin.pageLabel ?? "").match(/^(\d+)/)?.[1];
    if (!prefix) return;
    const requested = Number(prefix);
    const page = currentVolume()?.pages.filter(page => page <= requested).at(-1);
    if (page === state.page) return;
    updateWorkingCopy();
    if (state.document.dirty) {
      state.pendingPdfNavigation = { volume: state.volume, page: requested, pdfOrigin: origin };
      ui.notify("目录已变化；网页有未保存修改，保存后将匹配当前 PDF 页");
      return;
    }
    if (page == null) {
      ui.notify("当前 PDF 页及之前没有可用的网页文件", true);
      return;
    }
    await navigate(state.volume, requested, false, origin);
  }

  const directoryEvents = new EventSource("/api/events");
  directoryEvents.onmessage = event => {
    const change = JSON.parse(event.data);
    if (change.event === "change" || change.event === "rename") refreshLocalFile();
    if (change.event !== "rename" && change.event !== "ready") return;
    clearTimeout(directoryRefreshTimer);
    directoryRefreshTimer = setTimeout(() => refreshDirectory().catch(error => ui.notify(error.message, true)), 120);
  };
  window.addEventListener("pagehide", () => directoryEvents.close());

  window.addEventListener("focus", refreshLocalFile);
  document.addEventListener("visibilitychange", refreshLocalFile);
  init();
})();
