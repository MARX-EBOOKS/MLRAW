(() => {
  "use strict";
  const ui = window.ReaderUI;
  if (!ui) throw new Error("ReaderUI 未载入");

  const state = {
    config: null,
    volume: null,
    page: null,
    source: "",
    savedSource: "",
    mtime: null,
    editable: true,
    dirty: false,
    mode: "source",
    matches: [],
    match: -1,
    undo: [],
    redo: [],
    pendingVisualScroll: null,
    navigationRevision: 0,
    workingCopyRevision: 0,
    savePromise: null
  };

  const tags = [
    { id: "b", label: "B", shortcut: "b", open: "<b>", close: "</b>", title: "Alt+B / b" },
    { id: "i", label: "I", shortcut: "i", open: "<i>", close: "</i>", title: "Alt+I / i" },
    { id: "em", label: "EM", shortcut: "em", open: "<em>", close: "</em>", title: "Insert emphasis" },
    { id: "q", label: "Q", shortcut: "q", open: "<blockquote>", close: "</blockquote>", title: "Alt+Q / q" },
    { id: "a", label: "A", shortcut: "a", open: "<a href=\"\" id=\"\">", close: "</a>", title: "Alt+A / a" },
    { id: "x", label: "AID", shortcut: "x", open: "<a id=\"\">", close: "</a>", title: "Alt+X / x" },
    { id: "l", label: "HREF", shortcut: "l", open: "<a href=\"\">", close: "</a>", title: "Alt+L / l" },
    { id: "f", label: "FN", shortcut: "f", open: "<sup><a href=\"\" id=\"\">", close: "</a></sup>", title: "Alt+F / f" },
    { id: "r", label: "R", shortcut: "r", open: "<p align=\"right\">", close: "</p>", title: "Alt+R / r" },
    { id: "c", label: "C", shortcut: "c", open: "<p align=\"center\">", close: "</p>", title: "Alt+C / c" },
    { id: "ltgt", label: "&lt;&gt;", shortcut: "&lt;&gt;", open: "&lt;", close: "&gt;", title: "Insert angle bracket" },
    { id: "h1", label: "H1", shortcut: "1", open: "<h1>", close: "</h1>", title: "Alt+1 / 1" },
    { id: "h2", label: "H2", shortcut: "2", open: "<h2>", close: "</h2>", title: "Alt+2 / 2" },
    { id: "h3", label: "H3", shortcut: "3", open: "<h3>", close: "</h3>", title: "Alt+3 / 3" },
    { id: "h4", label: "H4", shortcut: "4", open: "<h4>", close: "</h4>", title: "Alt+4 / 4" },
    { id: "h5", label: "H5", shortcut: "5", open: "<h5>", close: "</h5>", title: "Alt+5 / 5" },
    { id: "h6", label: "H6", shortcut: "6", open: "<h6>", close: "</h6>", title: "Alt+6 / 6" },
    { id: "p", label: "P", shortcut: "p", open: "<p>", close: "</p>", title: "Alt+P / p" },
    { id: "div", label: "DIV", shortcut: "d", open: "<div>", close: "</div>", title: "Alt+D / d" },
    { id: "span", label: "SPAN", shortcut: "s", open: "<span>", close: "</span>", title: "Alt+S / s" },
    { id: "aside", label: "ASIDE", shortcut: "aside", open: "<aside>", close: "</aside>", title: "Aside" },
    { id: "sup", label: "SUP", shortcut: "sup", open: "<sup>", close: "</sup>", title: "Insert Superscript" },
    { id: "sub", label: "SUB", shortcut: "sub", open: "<sub>", close: "</sub>", title: "Insert Subscript" }
  ];
  const tagMap = new Map(tags.filter((tag) => tag.shortcut).map((tag) => [tag.shortcut.toLowerCase(), tag]));
  const attrs = [
    { id: "idAttr", label: "ID=", text: " id=\"\"", cursorOffset: 5, title: "Insert id attribute" },
    { id: "classAttr", label: "CLASS=", text: " class=\"\"", cursorOffset: 8, title: "Insert class attribute" },
    { id: "styleAttr", label: "STYLE=", text: " style=\"\"", cursorOffset: 8, title: "Insert style attribute" },
    { id: "hrs", label: "HRS", text: "<hr style=\"width: 20%;\">", cursorOffset: 22, title: "Insert short hardline" },
    { id: "noIndentAttr", label: "NO INDENT", text: " style=\"text-indent: 0;\"", cursorOffset: 23, title: "Insert no-indent style attribute" },
    { id: "HR", label: "HR", text: "<hr>", cursorOffset: 3, title: "Insert hardline" },
    { id: "BR", label: "BR", text: "<br>", cursorOffset: 3, title: "Insert change line" }
  ];
  const blockTagNames = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6"]);
  const blockTagIds = new Set(["p", "r", "c", "h1", "h2", "h3", "h4", "h5", "h6", "div"]);
  const voidTagNames = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const rawTagNames = new Set(["script", "style", "textarea", "title"]);
  const tagPattern = /<!--[\s\S]*?-->|<\/?[A-Za-z][\w:-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;

  function escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  async function api(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function currentVolume() {
    return state.config?.volumes.find((item) => item.id === state.volume);
  }

  function activeChapter() {
    let active = null;
    for (const item of currentVolume()?.toc || []) {
      if (item.page <= state.page) active = item;
      else break;
    }
    return active;
  }

  function pagePositionText() {
    const volume = currentVolume();
    if (!volume || state.page == null) return "";
    const index = volume.pages.indexOf(state.page);
    return `第 ${state.page} 页 · ${index + 1} / ${volume.pages.length}${state.dirty ? " *" : ""}`;
  }

  function markDirty(dirty = true) {
    state.dirty = dirty;
    ui.setDirty(dirty, pagePositionText());
  }

  function updateHistoryButtons() {
    ui.setHistoryButtons(Boolean(state.undo.length), Boolean(state.redo.length));
  }

  function sourceFromVisual() {
    const live = ui.getVisualDocument();
    if (!live?.body) return state.source;
    const parsed = new DOMParser().parseFromString(state.source, "text/html");
    parsed.body.innerHTML = live.body.innerHTML;
    parsed.head.querySelectorAll("[data-reader-editor]").forEach((node) => node.remove());
    const doctype = parsed.doctype ? `<!DOCTYPE ${parsed.doctype.name}>` : "<!doctype html>";
    return `${doctype}\n${parsed.documentElement.outerHTML}`;
  }

  function currentSource() {
    return state.mode === "visual" ? sourceFromVisual() : ui.getSource();
  }

  function updateWorkingCopy(source = currentSource()) {
    if (source !== state.source) state.workingCopyRevision += 1;
    state.source = source;
    // Keep the hidden source editor current while the visual editor is active.
    // This makes state.source the single live working copy in both modes.
    if (state.mode === "visual") ui.setSource(source);
    markDirty(source !== state.savedSource);
    return source;
  }

  function currentSnapshot() {
    const selection = ui.getSourceSelection();
    const visual = ui.getVisualDocument();
    const scroll = state.mode === "visual"
      ? { top: visual?.scrollingElement?.scrollTop || 0, left: visual?.scrollingElement?.scrollLeft || 0 }
      : ui.sourceScroll();
    return { text: currentSource(), ...selection, scroll };
  }

  function remember() {
    if (state.page == null) return;
    const snapshot = currentSnapshot();
    const last = state.undo.at(-1);
    if (!last || last.text !== snapshot.text || last.start !== snapshot.start || last.end !== snapshot.end) {
      state.undo.push(snapshot);
      if (state.undo.length > 100) state.undo.shift();
    }
    state.redo = [];
    updateHistoryButtons();
  }

  function applySnapshot(snapshot) {
    updateWorkingCopy(snapshot.text);
    if (state.mode === "source") {
      ui.setSource(snapshot.text);
      ui.setSourceSelection(Math.min(snapshot.start, snapshot.text.length), Math.min(snapshot.end, snapshot.text.length));
      ui.setSourceScroll(snapshot.scroll);
      ui.focusSource();
      refreshHighlight();
    } else {
      state.pendingVisualScroll = snapshot.scroll;
      renderVisual();
    }
    invalidateFind();
    updateHistoryButtons();
  }

  function undo() {
    const snapshot = state.undo.pop();
    if (!snapshot) return ui.notify("没有可撤销的操作");
    state.redo.push(currentSnapshot());
    applySnapshot(snapshot);
    ui.notify("已撤销");
  }

  function redo() {
    const snapshot = state.redo.pop();
    if (!snapshot) return ui.notify("没有可重做的操作");
    state.undo.push(currentSnapshot());
    applySnapshot(snapshot);
    ui.notify("已重做");
  }

  function injectEditorDocument(source) {
    const base = `<base href="/api/reader/resource/${encodeURIComponent(state.volume)}/">`;
    const style = '<style data-reader-editor>html{background:var(--reader-bg,#fff)}body{max-width:760px;margin:0 auto;padding:40px 48px 80px;background:var(--reader-bg,#fff);color:var(--reader-ink,#251f1b);caret-color:currentColor;font:18px/1.75 Georgia,"Noto Serif SC","SimSun",serif;outline:none}img{max-width:100%;height:auto}a{color:var(--reader-link,#8f2923)}.reader-ctrl-link a[href]{text-decoration:underline;cursor:pointer}body:focus{box-shadow:inset 0 0 0 2px #9d2b2430}</style>';
    if (/<head\b[^>]*>/i.test(source)) return source.replace(/<head\b[^>]*>/i, (head) => `${head}${base}${style}`);
    if (/<html\b[^>]*>/i.test(source)) return source.replace(/<html\b[^>]*>/i, (html) => `${html}<head>${base}${style}</head>`);
    return `<!doctype html><html><head>${base}${style}</head><body>${source}</body></html>`;
  }

  function renderVisual() {
    const scroll = state.pendingVisualScroll;
    state.pendingVisualScroll = null;
    ui.showVisual(injectEditorDocument(state.source), { editable: state.editable, scroll });
  }

  function setMode(mode = state.mode === "visual" ? "source" : "visual", { resetSourceScroll = false } = {}) {
    if (state.page == null) return;
    const next = mode === "visual" ? "visual" : "source";
    if (next !== state.mode) updateWorkingCopy();
    state.mode = next;
    ui.setMode(next);
    if (next === "source") {
      ui.setSource(state.source);
      if (resetSourceScroll) ui.setSourceScroll({ top: 0, left: 0 });
      refreshHighlight();
    } else {
      renderVisual();
    }
    syncUrl();
  }

  function syncUrl() {
    if (state.volume == null || state.page == null) return;
    history.replaceState(null, "", `?volume=${encodeURIComponent(state.volume)}&page=${state.page}&mode=${state.mode}`);
  }

  function nearestPage(pages, requested) {
    if (!pages.length) return null;
    if (pages.includes(requested)) return requested;
    return pages.reduce((best, page) => Math.abs(page - requested) < Math.abs(best - requested) ? page : best);
  }

  function pageNumberFromPdfLabel(pdfLabel) {
    const numericPrefix = String(pdfLabel ?? "").match(/^(\d+)/)?.[1];
    return numericPrefix ? Number(numericPrefix) : null;
  }

  async function loadPageOrPrevious(volume, requestedPage) {
    const candidates = volume.pages
      .filter((page) => page <= requestedPage)
      .sort((a, b) => b - a);

    for (const page of candidates) {
      try {
        const data = await api(`/api/reader/page/${encodeURIComponent(volume.id)}/${page}`);
        return { page, data, fellBack: page !== requestedPage };
      } catch (error) {
        if (!isMissingPageError(error)) throw error;
      }
    }
    return null;
  }

  function renderNavigation() {
    const volume = currentVolume();
    const index = volume.pages.indexOf(state.page);
    const chapter = activeChapter();
    ui.renderNavigation({
      chapterTitle: chapter?.title || volume.title,
      chapterPage: chapter?.page,
      pageContext: `${volume.shortTitle} · 第 ${state.page} 页`,
      pagePosition: pagePositionText(),
      page: state.page,
      volume: state.volume,
      hasPrevious: index > 0,
      hasNext: index < volume.pages.length - 1,
      editable: state.editable
    });
  }

  function isMissingPageError(error) {
    // 页面文件不存在（本地 ENOENT 或远程读取失败）时不应中断翻页：
    // 这类错误会被当作“占位页”处理，而不是让导航停在当前页反复回退。
    return /(ENOENT|no such file|远程页面读取失败)/i.test(error?.message || "");
  }

  async function navigate(targetVolume, targetPage, force = false, pdfOrigin = null) {
    if (!force && state.dirty && !(await save())) return false;
    const volume = state.config.volumes.find((item) => item.id === String(targetVolume));
    if (!volume) return false;
    const requestedPage = Number(targetPage);
    if (!Number.isFinite(requestedPage)) return false;
    const revision = ++state.navigationRevision;
    const workingCopyRevision = state.workingCopyRevision;
    try {
      const loaded = await loadPageOrPrevious(volume, requestedPage);
      if (!loaded) throw new Error(`第 ${requestedPage} 页及之前没有可用的网页文件`);
      if (revision !== state.navigationRevision) return true;
      if (workingCopyRevision !== state.workingCopyRevision || state.dirty) {
        if (!(await save())) return false;
        if (revision !== state.navigationRevision) return true;
        return navigate(volume.id, requestedPage, true, pdfOrigin);
      }

      const { page, data, fellBack } = loaded;
      const volumeChanged = state.volume !== volume.id;
      state.volume = volume.id;
      state.page = page;
      state.source = data.text;
      state.savedSource = data.text;
      state.workingCopyRevision += 1;
      state.mtime = data.mtime;
      state.editable = data.editable;
      state.undo = [];
      state.redo = [];
      state.matches = [];
      state.match = -1;
      updateHistoryButtons();
      markDirty(false);
      if (volumeChanged) ui.renderToc(volume.shortTitle, volume.toc);
      setMode(state.mode, { resetSourceScroll: true });
      renderNavigation();

      // PDF 发起的翻页已经处于正确的物理页，不反向驱动 PDF。
      // 左侧网页发起导航时才定位 PDF；UI 会在重复标签中选择离当前物理页最近的一项。
      if (!pdfOrigin) {
        ui.setPdf({ url: volume.pdfUrl, pageLabel: String(page) })
          .catch((error) => ui.notify(`PDF 载入失败：${error.message}`, true));
      }
      if (fellBack) ui.notify(`第 ${requestedPage} 页暂无网页文件，已显示上一可用页 ${page}`, false);
      else if (!state.editable) ui.notify("远程页面：只读");
      return true;
    } catch (error) {
      if (revision === state.navigationRevision) ui.notify(error.message, true);
      return false;
    }
  }

  async function performSave() {
    if (!state.editable || state.page == null) return true;
    updateWorkingCopy();
    const context = {
      volume: state.volume,
      page: state.page,
      text: state.source,
      mtime: state.mtime
    };
    try {
      const result = await api(`/api/reader/page/${encodeURIComponent(context.volume)}/${context.page}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: context.text, mtime: context.mtime })
      });
      if (context.volume === state.volume && context.page === state.page) {
        state.mtime = result.mtime;
        state.savedSource = context.text;
        updateWorkingCopy();
      }
      ui.notify("已保存");
      return true;
    } catch (error) {
      ui.notify(`保存失败：${error.message}`, true);
      return false;
    }
  }

  async function save() {
    while (state.dirty) {
      if (!state.savePromise) state.savePromise = performSave();
      const task = state.savePromise;
      const succeeded = await task;
      if (state.savePromise === task) state.savePromise = null;
      if (!succeeded) return false;
    }
    return true;
  }

  function attrToken(raw, value) {
    const link = raw.match(/^\s*href\s*=\s*(["'])([\s\S]*?)\1$/i);
    if (link) return `<span class="tok-string">${escapeHtml(link[1])}</span><span class="tok-link" data-href="${escapeHtml(link[2])}" title="Ctrl+click to open">${escapeHtml(link[2])}</span><span class="tok-string">${escapeHtml(link[1])}</span>`;
    return `<span class="tok-string">${escapeHtml(value)}</span>`;
  }

  function colorTag(raw) {
    if (raw.startsWith("<!--")) return `<span class="tok-comment">${escapeHtml(raw)}</span>`;
    let result = "", last = 0;
    const pattern = /(<\/?)([A-Za-z][\w:-]*)|([\w:-]+)(\s*=\s*)("[^"]*"|'[^']*')|([<>\/=])/g;
    for (let match; (match = pattern.exec(raw));) {
      result += escapeHtml(raw.slice(last, match.index));
      if (match[1]) result += `${escapeHtml(match[1])}<span class="tok-tag">${escapeHtml(match[2])}</span>`;
      else if (match[3]) result += `<span class="tok-attr">${escapeHtml(match[3])}</span>${escapeHtml(match[4])}${attrToken(match[0], match[5])}`;
      else result += escapeHtml(match[6]);
      last = match.index + match[0].length;
    }
    return result + escapeHtml(raw.slice(last));
  }

  function colorHtml(text) {
    let result = "", last = 0;
    const pattern = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*?>/g;
    for (let match; (match = pattern.exec(text));) {
      result += escapeHtml(text.slice(last, match.index)) + colorTag(match[0]);
      last = match.index + match[0].length;
    }
    return result + escapeHtml(text.slice(last)) + (text.endsWith("\n") ? " " : "");
  }

  function refreshHighlight() {
    ui.updateHighlight(colorHtml(ui.getSource()));
  }

  function gotoAnchor(fragment) {
    const id = decodeURIComponent(fragment.slice(1));
    if (!id) return false;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\bid\\s*=\\s*(["'])${escaped}\\1`, "i").exec(ui.getSource());
    if (!match) return false;
    const start = match.index + match[0].lastIndexOf(id);
    ui.focusSource();
    ui.setSourceSelection(start, start + id.length);
    ui.scrollSourceSelectionIntoView(start);
    ui.notify(`已跳转到 ${fragment}`);
    return true;
  }

  function openSourceHref(href) {
    if (href.startsWith("#")) {
      if (!gotoAnchor(href)) ui.notify(`未找到锚点：${href}`);
      return;
    }
    const base = `/api/reader/resource/${encodeURIComponent(state.volume)}/`;
    window.open(new URL(href, location.origin + base).href, "_blank", "noopener");
  }

  function openHighlightedLink(event) {
    if (!(event.ctrlKey || event.metaKey)) return;
    const link = event.target.closest(".tok-link[data-href]");
    if (!link) return;
    event.preventDefault();
    openSourceHref(link.dataset.href);
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
    let remaining = leading;
    for (const node of nodes) {
      if (!remaining) break;
      const start = node === range.startContainer ? range.startOffset : 0;
      const cut = Math.min(remaining, node.textContent.length - start);
      range.setStart(node, start + cut);
      remaining -= cut;
    }
    remaining = trailing;
    for (let index = nodes.length - 1; index >= 0 && remaining; index--) {
      const node = nodes[index];
      const end = node === range.endContainer ? range.endOffset : node.textContent.length;
      const cut = Math.min(remaining, end);
      range.setEnd(node, end - cut);
      remaining -= cut;
    }
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function trimSourceWordSelection() {
    const text = ui.getSource();
    let { start, end } = ui.getSourceSelection();
    if (start === end) return;
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    ui.setSourceSelection(start, end);
  }

  function tagInfo(open) {
    const match = String(open).match(/^<([a-z][\w:-]*)([^>]*)>/i);
    if (!match) return null;
    const name = match[1].toLowerCase();
    const align = match[2].match(/\balign\s*=\s*["']?([^"'\s>]+)/i)?.[1]?.toLowerCase() || "";
    return { name, kind: name === "p" && align ? `p:${align}` : name, block: blockTagNames.has(name) };
  }

  function elementTagInfo(element) {
    const name = element.tagName.toLowerCase();
    const align = (element.getAttribute("align") || "").toLowerCase();
    return { name, kind: name === "p" && align ? `p:${align}` : name };
  }

  function buildTagEdit(text, start, end, tag) {
    const elements = tagPairs(text);
    const selected = text.slice(start, end);
    const name = tagName(tag.open);
    const complete = start < end && isCompleteSelection(text, elements, start, end);
    const exact = complete && elements.find((element) => element.start === start && element.end === end);

    // 完整选中时操作外层；否则只操作包住选区的最内层。
    if (complete) {
      // 错配闭合标签：以前面的开始标签为准。点击同类标签删除，
      // 点击其他标签则直接替换整个外层，而不是再包一层。
      if (exact && exact.closeName && exact.closeName !== exact.name) {
        if (name === exact.name) return changeWrapper(text, exact, start, end);
        return changeWrapper(text, exact, start, end, tag);
      }
      if (exact && isBlock(exact) && blockTagIds.has(tag.id)) {
        if (blockId(exact) === tag.id) return changeWrapper(text, exact, start, end);
        if (tag.id !== "div") return changeWrapper(text, exact, start, end, tag);
      }
      if (exact && exact.name === name && isSimplePair(tag)) return changeWrapper(text, exact, start, end);
      if (tag.close && selected.startsWith(tag.open) && selected.endsWith(tag.close)) {
        const inner = selected.slice(tag.open.length, -tag.close.length);
        return { start, end, text: inner, selectStart: 0, selectEnd: inner.length };
      }
      return wrapEdit(start, end, selected, tag, true);
    }

    const block = blockTagIds.has(tag.id) && innermost(elements.filter(isBlock), start, end);
    if (block) return changeWrapper(text, block, start, end, blockId(block) === tag.id ? undefined : tag);

    const same = name && isSimplePair(tag) && innermost(elements.filter((element) => element.name === name), start, end);
    if (same) return changeWrapper(text, same, start, end);

    const before = start - tag.open.length;
    const after = end + tag.close.length;
    if (tag.close && before >= 0 && text.slice(before, start) === tag.open && text.slice(end, after) === tag.close) {
      return { start: before, end: after, text: selected, selectStart: 0, selectEnd: selected.length };
    }
    return wrapEdit(start, end, selected, tag, false);
  }

  function changeWrapper(text, element, start, end, tag) {
    const open = tag?.open || "", close = tag?.close || "";
    const inner = text.slice(element.openEnd, element.closeStart);
    const whole = start === element.start && end === element.end;
    const inOpeningTag = start === end && element.start < start && start < element.openEnd;
    const from = whole || inOpeningTag ? 0 : start - element.openEnd;
    const to = whole ? inner.length : inOpeningTag ? 0 : end - element.openEnd;
    return {
      start: element.start,
      end: element.end,
      text: open + inner + close,
      selectStart: open.length + from,
      selectEnd: open.length + to
    };
  }

  function wrapEdit(start, end, selected, tag, keepSelection) {
    const text = tag.open + selected + tag.close;
    const emptyAttribute = tag.open.indexOf('=""');
    const cursor = emptyAttribute >= 0 ? emptyAttribute + 2 : selected ? text.length : tag.open.length;
    return {
      start, end, text,
      selectStart: keepSelection ? tag.open.length : cursor,
      selectEnd: keepSelection ? tag.open.length + selected.length : cursor
    };
  }

  function innermost(elements, start, end) {
    return elements
      .filter((element) => (start === end && element.start < start && start < element.openEnd) ||
        (element.openEnd <= start && end <= element.closeStart))
      .reduce((inner, element) => !inner || element.end - element.start < inner.end - inner.start ? element : inner, undefined);
  }

  function isCompleteSelection(text, elements, start, end) {
    let cursor = skipSpace(text, start, end), found = false;
    while (cursor < end) {
      const outer = elements
        .filter((element) => element.start === cursor && element.end <= end)
        .reduce((root, element) => !root || element.end > root.end ? element : root, undefined);
      if (!outer) return false;
      found = true;
      cursor = skipSpace(text, outer.end, end);
    }
    return found;
  }

  function skipSpace(text, start, end) {
    while (start < end && /\s/.test(text[start])) start += 1;
    return start;
  }

  function tagPairs(text) {
    const stack = [], pairs = [];
    let rawName;
    tagPattern.lastIndex = 0;
    for (let match; (match = tagPattern.exec(text));) {
      const token = match[0];
      if (token.startsWith("<!--")) continue;
      const name = token.match(/^<\/?([A-Za-z][\w:-]*)/i)[1].toLowerCase();
      const closing = /^<\//.test(token);

      if (rawName && !(closing && name === rawName)) continue;
      if (closing) {
        const open = stack[stack.length - 1];
        if (open?.name === name) {
          // 正常闭合：仍然优先按同名标签配对。
          stack.pop();
          pairs.push({ name: open.name, closeName: name, start: open.start, openEnd: open.end, closeStart: match.index, end: tagPattern.lastIndex, open: open.token });
          if (name === rawName) rawName = undefined;
        } else {
          const crossed = stack.map((item) => item.name).lastIndexOf(name);
          if (crossed >= 0) {
            // 存在同名开始标签时，沿用原来的交叉标签恢复逻辑。
            stack.length = crossed;
          } else if (open) {
            // 容错：结束标签名称不一致时，以最近的开始标签为准。
            // 例如 <p align="center">text</h1> 会被视作一个 p 元素。
            stack.pop();
            pairs.push({ name: open.name, closeName: name, start: open.start, openEnd: open.end, closeStart: match.index, end: tagPattern.lastIndex, open: open.token });
          }
        }
      } else if (voidTagNames.has(name) || /\/\s*>$/.test(token)) {
        pairs.push({ name, start: match.index, openEnd: tagPattern.lastIndex, closeStart: tagPattern.lastIndex, end: tagPattern.lastIndex, open: token });
      } else {
        stack.push({ name, start: match.index, end: tagPattern.lastIndex, token });
        if (rawTagNames.has(name)) rawName = name;
      }
    }
    return pairs;
  }

  function tagName(open) {
    return /^<([A-Za-z][\w:-]*)\b/.exec(open)?.[1].toLowerCase();
  }

  function isSimplePair(tag) {
    const name = tagName(tag.open);
    return Boolean(name && tag.close.toLowerCase() === `</${name}>`);
  }

  function isBlock(element) {
    return element.name === "p" || element.name === "div" || /^h[1-6]$/.test(element.name);
  }

  function blockId(element) {
    if (element.name !== "p") return element.name;
    const align = element.open.match(/\balign\s*=\s*["']?(center|right)/i)?.[1]?.toLowerCase();
    return align === "center" ? "c" : align === "right" ? "r" : "p";
  }

  function selectVisualContents(element, doc) {
    const range = doc.createRange();
    range.selectNodeContents(element);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function unwrapVisual(element, doc) {
    const parent = element.parentNode;
    const first = element.firstChild, last = element.lastChild;
    if (!parent) return;
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    element.remove();
    if (!first || !last) return;
    const range = doc.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function replaceVisual(element, open, doc) {
    const template = doc.createElement("template");
    template.innerHTML = open;
    const replacement = template.content.firstElementChild;
    if (!replacement) return;
    while (element.firstChild) replacement.append(element.firstChild);
    element.replaceWith(replacement);
    selectVisualContents(replacement, doc);
  }

  function insertVisual(tag) {
    const doc = ui.getVisualDocument();
    if (!doc?.body || !state.editable) return;
    remember();
    const info = tagInfo(tag.open);
    const selection = doc.getSelection();
    const anchor = selection?.anchorNode?.nodeType === doc.defaultView.Node.ELEMENT_NODE
      ? selection.anchorNode : selection?.anchorNode?.parentElement;
    const container = info && anchor?.closest?.(info.block ? "p,div,h1,h2,h3,h4,h5,h6" : info.name);
    let action = "已插入";
    if (container && doc.body.contains(container)) {
      if (elementTagInfo(container).kind === info.kind) {
        unwrapVisual(container, doc);
        action = "已移除";
      } else {
        replaceVisual(container, tag.open, doc);
        action = "已替换";
      }
    } else {
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (!range) return;
      const template = doc.createElement("template");
      const holder = doc.createElement("div");
      holder.append(range.cloneContents());
      template.innerHTML = tag.open + holder.innerHTML + tag.close;
      const fragment = template.content;
      const inserted = [...fragment.childNodes];
      range.deleteContents();
      range.insertNode(fragment);
      if (inserted.length) {
        const nextRange = doc.createRange();
        nextRange.setStartBefore(inserted[0]);
        nextRange.setEndAfter(inserted.at(-1));
        selection.removeAllRanges();
        selection.addRange(nextRange);
      }
    }
    updateWorkingCopy();
    invalidateFind();
    doc.body.focus();
    return action;
  }

  function insertSource(text, close = "", offset = null, tag = null) {
    const selection = ui.getSourceSelection();
    remember();
    let action = "已插入";
    if (tag) {
      const source = ui.getSource();
      const operation = buildTagEdit(source, selection.start, selection.end, tag);
      const removed = operation.text.length < operation.end - operation.start;
      const wrapped = tag.open + source.slice(selection.start, selection.end) + tag.close;
      const replaced = !removed && operation.text !== wrapped;
      ui.replaceSourceRange(operation.text, operation.start, operation.end, "select");
      ui.setSourceSelection(operation.start + operation.selectStart, operation.start + operation.selectEnd);
      action = removed ? "已移除" : replaced ? "已替换" : action;
    } else {
      const selected = ui.getSource().slice(selection.start, selection.end);
      ui.replaceSourceRange(text + selected + close, selection.start, selection.end, "end");
      if (!selected && close) ui.setSourceSelection(selection.start + (offset ?? text.length));
      else if (offset != null) ui.setSourceSelection(selection.start + offset);
    }
    updateWorkingCopy(ui.getSource());
    invalidateFind();
    refreshHighlight();
    ui.focusSource();
    return action;
  }

  function editTag(tag) {
    const action = state.mode === "visual" ? insertVisual(tag) : insertSource(tag.open, tag.close, null, tag);
    if (action) ui.notify(`${action} ${tag.label}`);
  }

  function compileFindPattern() {
    const options = ui.findOptions();
    if (!options.query) return null;
    const source = options.regex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return { pattern: new RegExp(source, `g${options.caseSensitive ? "" : "i"}`), options };
  }

  function findAll(reset = true) {
    if (reset) state.match = -1;
    state.matches = [];
    try {
      const compiled = compileFindPattern();
      if (!compiled) {
        ui.setFindInfo("");
        return;
      }
      for (let match; (match = compiled.pattern.exec(ui.getSource()));) {
        state.matches.push([match.index, match.index + match[0].length]);
        if (!match[0]) compiled.pattern.lastIndex += 1;
      }
      ui.setFindInfo(`${state.matches.length} 处`);
    } catch (error) {
      ui.setFindInfo(error.message);
    }
  }

  function invalidateFind() {
    findAll(true);
  }

  function nextMatch() {
    if (!state.matches.length) findAll(false);
    if (!state.matches.length) return;
    state.match = (state.match + 1) % state.matches.length;
    const [start, end] = state.matches[state.match];
    ui.focusSource();
    ui.setSourceSelection(start, end);
    ui.scrollSourceSelectionIntoView(start);
    ui.setFindInfo(`${state.match + 1}/${state.matches.length}`);
  }

  function replaceOne() {
    if (state.match < 0 || !state.matches[state.match]) nextMatch();
    if (state.match < 0 || !state.matches[state.match]) return;
    const [start, end] = state.matches[state.match];
    remember();
    ui.replaceSourceRange(ui.findOptions().replacement, start, end, "end");
    updateWorkingCopy(ui.getSource());
    refreshHighlight();
    findAll(true);
  }

  function replaceAll() {
    try {
      const compiled = compileFindPattern();
      if (!compiled) return;
      remember();
      const replacement = compiled.options.replacement;
      const replaced = compiled.options.regex
        ? ui.getSource().replace(compiled.pattern, replacement)
        : ui.getSource().replace(compiled.pattern, () => replacement);
      ui.setSource(replaced);
      updateWorkingCopy(replaced);
      refreshHighlight();
      findAll(true);
    } catch (error) {
      ui.setFindInfo(error.message);
    }
  }

  function adjacent(direction) {
    const pages = currentVolume()?.pages || [];
    const index = pages.indexOf(state.page);
    if (pages[index + direction] != null) navigate(state.volume, pages[index + direction]);
  }

  function handleKeyDown(event) {
    const key = event.key.toLowerCase();
    const command = event.ctrlKey || event.metaKey;
    const formField = event.target.matches?.("input, textarea:not(#editor), select");
    ui.setSourceLinkMode(command);
    if (command && key === "s") {
      event.preventDefault();
      save();
      return;
    }
    if (command && !formField && (key === "z" || key === "y")) {
      event.preventDefault();
      key === "y" || event.shiftKey ? redo() : undo();
      return;
    }
    if (event.key === "Escape") ui.setToc(false);
    if (formField) return;
    if (event.altKey && !command) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        adjacent(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      const hotkey = event.key === "Enter" ? "enter" : key;
      const tag = tagMap.get(hotkey);
      if (tag) {
        event.preventDefault();
        editTag(tag);
      }
      return;
    }
    const editableTarget = event.target.matches?.("textarea,[contenteditable]") || event.target.isContentEditable;
    if (!editableTarget && (event.key === "ArrowLeft" || event.key === "ArrowRight")) adjacent(event.key === "ArrowLeft" ? -1 : 1);
  }

  async function changeVolume(id) {
    const volume = state.config.volumes.find((item) => item.id === id);
    if (!volume || !(await navigate(volume.id, volume.pages[0]))) renderNavigation();
  }

  async function init() {
    ui.init({
      mode: () => setMode(), save, undo, redo, volume: changeVolume,
      page: (page) => navigate(state.volume, page), adjacent,
      tag: (index) => editTag(tags[index]),
      attr: (index) => {
        if (state.mode === "visual") return ui.notify("属性按钮请在源代码模式使用");
        const attr = attrs[index];
        insertSource(attr.text, "", attr.cursorOffset);
      },
      beforeEdit: remember,
      sourceInput: () => { updateWorkingCopy(ui.getSource()); refreshHighlight(); invalidateFind(); },
      visualInput: () => { updateWorkingCopy(); refreshHighlight(); invalidateFind(); },
      sourceScroll: refreshHighlight,
      sourceDoubleClick: trimSourceWordSelection,
      visualDoubleClick: trimVisualWordSelection,
      visualClick: openVisualLink,
      highlightClick: openHighlightedLink,
      pdfPageChange: ({ pageNumber, pageLabel }) => {
        const volume = currentVolume();
        if (!volume) return;
        const page = pageNumberFromPdfLabel(pageLabel);
        if (page != null) navigate(volume.id, page, false, { pageNumber, pageLabel });
      },
      find: nextMatch,
      nextMatch,
      replace: replaceOne,
      replaceAll,
      findChanged: invalidateFind,
      keyDown: handleKeyDown,
      beforeUnload: (event) => {
        if (!state.dirty) return;
        event.preventDefault();
        event.returnValue = "";
      }
    });
    ui.renderTools(tags, attrs);
    updateHistoryButtons();
    try {
      state.config = await api("/api/reader/config");
      const params = new URLSearchParams(location.search);
      const requestedMode = params.get("mode");
      if (requestedMode === "source" || requestedMode === "visual") state.mode = requestedMode;
      const firstVolume = state.config.volumes.find((item) => item.id === params.get("volume")) || state.config.volumes[0];
      if (!firstVolume) throw new Error("配置中没有找到包含 HTML 页面的卷册");
      ui.renderVolumes(state.config.volumes, firstVolume.id);
      await navigate(firstVolume.id, Number(params.get("page")) || firstVolume.pages[0], true);
    } catch (error) {
      ui.renderNavigation({
        chapterTitle: "载入失败", chapterPage: null, pageContext: "", pagePosition: "",
        page: "", volume: "", hasPrevious: false, hasNext: false, editable: false
      });
      ui.notify(error.message, true);
    }
  }

  init();
})();
