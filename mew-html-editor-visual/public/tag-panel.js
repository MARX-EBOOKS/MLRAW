(() => {
  "use strict";
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
    ...Array.from({ length: 6 }, (_, index) => {
      const shortcut = String(index + 1), id = `h${shortcut}`;
      return { id, label: id.toUpperCase(), shortcut, open: `<${id}>`, close: `</${id}>`, title: `Alt+${shortcut} / ${shortcut}` };
    }),
    { id: "p", label: "P", shortcut: "p", open: "<p>", close: "</p>", title: "Alt+P / p" },
    { id: "div", label: "DIV", shortcut: "d", open: "<div>", close: "</div>", title: "Alt+D / d" },
    { id: "span", label: "SPAN", shortcut: "s", open: "<span>", close: "</span>", title: "Alt+S / s" },
    { id: "aside", label: "ASIDE", shortcut: "aside", open: "<aside>", close: "</aside>", title: "Aside" },
    { id: "sup", label: "SUP", shortcut: "sup", open: "<sup>", close: "</sup>", title: "Insert Superscript" },
    { id: "sub", label: "SUB", shortcut: "sub", open: "<sub>", close: "</sub>", title: "Insert Subscript" }
  ];
  const attrs = [
    { id: "idAttr", label: "ID=", text: " id=\"\"", cursorOffset: 5, title: "Insert id attribute" },
    { id: "classAttr", label: "CLASS=", text: " class=\"\"", cursorOffset: 8, title: "Insert class attribute" },
    { id: "styleAttr", label: "STYLE=", text: " style=\"\"", cursorOffset: 8, title: "Insert style attribute" },
    { id: "hrs", label: "HRS", text: "<hr style=\"width: 20%;\">", cursorOffset: 22, title: "Insert short hardline" },
    { id: "noIndentAttr", label: "NO INDENT", text: " style=\"text-indent: 0;\"", cursorOffset: 23, title: "Insert no-indent style attribute" },
    { id: "HR", label: "HR", text: "<hr>", cursorOffset: 3, title: "Insert hardline" },
    { id: "BR", label: "BR", text: "<br>", cursorOffset: 3, title: "Insert change line" }
  ];
  const tagMap = new Map(tags.filter(tag => tag.shortcut).map(tag => [tag.shortcut.toLowerCase(), tag]));
  const blockTagNames = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6"]);
  const blockTagIds = new Set(["p", "r", "c", "h1", "h2", "h3", "h4", "h5", "h6", "div"]);
  const voidTagNames = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const rawTagNames = new Set(["script", "style", "textarea", "title"]);
  const tagPattern = /<!--[\s\S]*?-->|<\/?[A-Za-z][\w:-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;

  function changeWrapper(text, element, start, end, tag) {
    const open = tag?.open || "", close = tag?.close || "";
    const inner = text.slice(element.openEnd, element.closeStart);
    const whole = start === element.start && end === element.end;
    const inOpeningTag = start === end && element.start < start && start < element.openEnd;
    const from = whole || inOpeningTag ? 0 : start - element.openEnd;
    const to = whole ? inner.length : inOpeningTag ? 0 : end - element.openEnd;
    return { start: element.start, end: element.end, text: open + inner + close,
      selectStart: open.length + from, selectEnd: open.length + to };
  }

  function wrapEdit(start, end, selected, tag, keepSelection) {
    const text = tag.open + selected + tag.close;
    const emptyAttribute = tag.open.indexOf('=""');
    const cursor = emptyAttribute >= 0 ? emptyAttribute + 2 : selected ? text.length : tag.open.length;
    return { start, end, text,
      selectStart: keepSelection ? tag.open.length : cursor,
      selectEnd: keepSelection ? tag.open.length + selected.length : cursor };
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
        const open = stack.at(-1);
        const crossed = stack.findLastIndex(item => item.name === name);
        if (open && (open.name === name || crossed < 0)) {
          stack.pop();
          pairs.push({ name: open.name, closeName: name, start: open.start, openEnd: open.end,
            closeStart: match.index, end: tagPattern.lastIndex, open: open.token });
          if (name === rawName) rawName = undefined;
        } else if (crossed >= 0) stack.length = crossed;
      } else if (voidTagNames.has(name) || /\/\s*>$/.test(token)) {
        pairs.push({ name, start: match.index, openEnd: tagPattern.lastIndex,
          closeStart: tagPattern.lastIndex, end: tagPattern.lastIndex, open: token });
      } else {
        stack.push({ name, start: match.index, end: tagPattern.lastIndex, token });
        if (rawTagNames.has(name)) rawName = name;
      }
    }
    return pairs;
  }

  function innermost(elements, start, end) {
    return elements
      .filter(element => (start === end && element.start < start && start < element.openEnd) ||
        (element.openEnd <= start && end <= element.closeStart))
      .reduce((inner, element) => !inner || element.end - element.start < inner.end - inner.start ? element : inner, undefined);
  }

  function isCompleteSelection(text, elements, start, end) {
    const byStart = new Map(elements.map(element => [element.start, element]));
    let cursor = start, found = false;
    while (cursor < end) {
      if (/\s/.test(text[cursor])) { cursor += 1; continue; }
      const outer = byStart.get(cursor);
      if (!outer || outer.end > end) return false;
      found = true;
      cursor = outer.end;
    }
    return found;
  }

  function blockId(element) {
    if (element.name !== "p") return element.name;
    const align = element.open.match(/\balign\s*=\s*["']?(center|right)/i)?.[1]?.toLowerCase();
    return align === "center" ? "c" : align === "right" ? "r" : "p";
  }

  function buildTagEdit(text, start, end, tag) {
    const elements = tagPairs(text);
    const selected = text.slice(start, end);
    const name = /^<([A-Za-z][\w:-]*)\b/.exec(tag.open)?.[1].toLowerCase();
    const simple = name && tag.close.toLowerCase() === `</${name}>`;
    const complete = start < end && isCompleteSelection(text, elements, start, end);
    const exact = complete && elements.find(element => element.start === start && element.end === end);
    if (complete) {
      if (exact && exact.closeName && exact.closeName !== exact.name) {
        return changeWrapper(text, exact, start, end, name === exact.name ? undefined : tag);
      }
      if (exact && blockTagNames.has(exact.name) && blockTagIds.has(tag.id)) {
        if (blockId(exact) === tag.id) return changeWrapper(text, exact, start, end);
        if (tag.id !== "div") return changeWrapper(text, exact, start, end, tag);
      }
      if (exact && exact.name === name && simple) return changeWrapper(text, exact, start, end);
      if (tag.close && selected.startsWith(tag.open) && selected.endsWith(tag.close)) {
        const inner = selected.slice(tag.open.length, -tag.close.length);
        return { start, end, text: inner, selectStart: 0, selectEnd: inner.length };
      }
      return wrapEdit(start, end, selected, tag, true);
    }
    const block = blockTagIds.has(tag.id) && innermost(elements.filter(element => blockTagNames.has(element.name)), start, end);
    if (block) return changeWrapper(text, block, start, end, blockId(block) === tag.id ? undefined : tag);
    const same = simple && innermost(elements.filter(element => element.name === name), start, end);
    if (same) return changeWrapper(text, same, start, end);
    const before = start - tag.open.length, after = end + tag.close.length;
    if (tag.close && before >= 0 && text.slice(before, start) === tag.open && text.slice(end, after) === tag.close) {
      return { start: before, end: after, text: selected, selectStart: 0, selectEnd: selected.length };
    }
    return wrapEdit(start, end, selected, tag, false);
  }

  function applyTag(editor, tag) {
    const { start, end } = editor.selection();
    const operation = buildTagEdit(editor.getValue(), start, end, tag);
    editor.replaceRange(operation.text, operation.start, operation.end,
      operation.start + operation.selectStart, operation.start + operation.selectEnd, "mew.tag");
    editor.editor?.revealRangeInCenterIfOutsideViewport(editor.editor.getSelection());
    editor.focus();
    return operation;
  }

  function insert(editor, attr) {
    const { start, end } = editor.selection();
    const cursor = start + (attr.cursorOffset ?? attr.text.length);
    editor.replaceRange(attr.text, start, end, cursor, cursor, "mew.attr");
    editor.focus();
  }

  const MIN_SCALE = .8, MAX_SCALE = 1.6, SNAP = 56, CONTROL_HEIGHT = 28;
  const DOCKS = [
    ["editor-top", "栏上", "停靠编辑框上方（与编辑框等宽）"],
    ["editor-bottom", "栏下", "停靠编辑框下方（与编辑框等宽）"],
    ["window-top", "窗上", "停靠窗口顶部（与窗口等宽）"],
    ["window-bottom", "窗下", "停靠窗口底部（与窗口等宽）"],
    ["floating", "浮动", "自由浮动（可拖动、可拉伸）"]
  ];
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
  const makeButton = (label, title, className, data = {}) => {
    const result = node("button", className, label);
    Object.assign(result, { type: "button", title });
    Object.assign(result.dataset, data);
    result.setAttribute("aria-label", title);
    return result;
  };

  function mount(options = {}) {
    const content = typeof options.content === "string" ? document.querySelector(options.content) : options.content;
    const host = typeof options.host === "string" ? document.querySelector(options.host) : options.host;
    if (!content || !host || content.closest(".float-panel")) return null;
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(options.storageKey) || "{}") || {}; } catch {}
    const oldPanel = stored.tagBar || stored.tagPanel || stored;
    const state = Object.assign({ dock: "editor-top", x: 60, y: 96, w: 520, h: null, scale: 1 }, oldPanel);
    if (state.dock === "top") state.dock = "editor-top";
    if (state.dock === "bottom") state.dock = "editor-bottom";
    if (!DOCKS.some(item => item[0] === state.dock)) state.dock = "editor-top";
    state.scale = clamp(Number(state.scale) || Number(options.initialTagScale) || 1, MIN_SCALE, MAX_SCALE);
    let editorScale = clamp(Number(stored.editorScale ?? stored._editorScale) || Number(options.initialEditorScale) || 1, MIN_SCALE, MAX_SCALE);

    const panel = node("div", "float-panel");
    panel.id = options.panelId || "tagPanel";
    panel.dataset.panel = content.id || "tagBar";
    const header = node("div", "fp-header");
    header.id = options.gripId || "tagPanelGrip";
    header.title = "编辑按钮：按住标题栏拖动可自由浮动，拖到窗口上/下边缘可停靠，双击恢复默认";
    const title = node("strong", "fp-title", options.title || "编辑按钮");
    title.id = options.titleId || "tagPanelTitle";
    const actions = node("span", "fp-actions");
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", "编辑按钮与编辑框尺寸及停靠位置");
    header.append(node("span", "fp-grip", "≡"), title, actions);
    content.classList.add("tag-bar");
    content.parentNode.insertBefore(panel, content);
    panel.append(header, content);

    const makeScale = (target, label) => {
      const group = node("span", "fp-scale-actions");
      group.dataset.scaleTarget = target;
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", `${label}缩放`);
      const input = node("input", "fp-scale-input");
      Object.assign(input, { type: "text", inputMode: "decimal", maxLength: 5, value: "100%", title: `${label}缩放比例：输入 80%–160% 后按回车；双击恢复 100%` });
      input.dataset.scaleInput = target;
      input.setAttribute("aria-label", `${label}缩放比例`);
      group.append(node("span", "fp-scale-label", target === "editor" ? "编辑" : "标签"), makeButton("−", `缩小${label}（Ctrl+−）`, "fp-scale-control", { scaleAction: "smaller" }), input, makeButton("＋", `放大${label}（Ctrl+＋）`, "fp-scale-control", { scaleAction: "larger" }));
      return group;
    };
    actions.append(makeScale("editor", "编辑框"), makeScale("tag", "标签按钮"));
    for (const [dock, label, tip] of DOCKS) actions.append(makeButton(label, tip, "fp-dock", { dock }));
    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      const handle = node("div", `fp-handle fp-handle-${dir}`);
      handle.dataset.dir = dir;
      panel.append(handle);
    }
    const snapTop = node("div", "fp-snap fp-snap-top"), snapBottom = node("div", "fp-snap fp-snap-bottom");
    document.body.append(snapTop, snapBottom);

    const chromeHeights = () => ({
      header: Math.round(document.querySelector(options.headerSelector || "header")?.getBoundingClientRect().height || 0),
      footer: Math.round(document.querySelector(options.footerSelector || "footer")?.getBoundingClientRect().height || 0)
    });
    const minHeight = () => Math.ceil((header.getBoundingClientRect().height || 29) + CONTROL_HEIGHT * state.scale);
    const heightLimit = () => {
      const chrome = chromeHeights();
      if (state.dock.startsWith("editor-")) return Math.max(minHeight(), host.getBoundingClientRect().height - 40);
      return Math.max(minHeight(), innerHeight - chrome.header - chrome.footer);
    };
    const save = () => {
      try { localStorage.setItem(options.storageKey, JSON.stringify({ dock: state.dock, x: Math.round(state.x), y: Math.round(state.y), w: Math.round(state.w), h: state.h == null ? null : Math.round(state.h), scale: state.scale, editorScale })); } catch {}
    };
    const updateScale = target => {
      const value = target === "editor" ? editorScale : state.scale;
      const input = actions.querySelector(`[data-scale-input="${target}"]`);
      input.value = `${Math.round(value * 100)}%`;
      const group = input.closest(".fp-scale-actions");
      group.querySelector('[data-scale-action="smaller"]').disabled = value <= MIN_SCALE;
      group.querySelector('[data-scale-action="larger"]').disabled = value >= MAX_SCALE;
      if (target === "editor") options.setEditorScale?.(editorScale);
      else {
        panel.style.setProperty("--fp-scale", state.scale);
        panel.style.setProperty("--fp-content-min-height", `${Math.ceil(CONTROL_HEIGHT * state.scale)}px`);
      }
    };
    const updateWindowDock = () => {
      const chrome = chromeHeights();
      const height = state.dock.startsWith("window-") ? Math.round(panel.getBoundingClientRect().height) : 0;
      const top = state.dock === "window-top" ? height : 0, bottom = state.dock === "window-bottom" ? height : 0;
      if (top) panel.style.top = `${chrome.header}px`;
      if (bottom) panel.style.bottom = `${chrome.footer}px`;
      document.documentElement.style.setProperty("--window-dock-top", `${top}px`);
      document.documentElement.style.setProperty("--window-dock-bottom", `${bottom}px`);
      snapTop.style.top = `${chrome.header + top}px`;
      snapBottom.style.bottom = `${chrome.footer + bottom}px`;
      options.onLayout?.();
    };
    const clampFloating = () => {
      if (state.dock !== "floating") return;
      const chrome = chromeHeights();
      state.w = clamp(state.w, 220, innerWidth);
      state.h = clamp(state.h || panel.getBoundingClientRect().height || 80, minHeight(), innerHeight - chrome.header - chrome.footer);
      state.x = clamp(state.x, 36 - state.w, innerWidth - 36);
      state.y = clamp(state.y, chrome.header, innerHeight - chrome.footer - 28);
      Object.assign(panel.style, { left: `${state.x}px`, top: `${state.y}px`, width: `${state.w}px`, height: `${state.h}px` });
    };
    const apply = () => {
      panel.className = `float-panel ${state.dock === "floating" ? "floating" : `dock-${state.dock}`}`;
      host.classList.toggle("bar-bottom", state.dock === "editor-bottom");
      host.classList.toggle("bar-fixed", state.dock.startsWith("window-") || state.dock === "floating");
      panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = panel.style.width = "";
      let height = state.h;
      if (height != null) height = state.h = clamp(height, minHeight(), heightLimit());
      panel.style.height = height == null ? "" : `${height}px`;
      panel.classList.toggle("auto-height", height == null);
      updateScale("tag");
      clampFloating();
      panel.querySelectorAll(".fp-dock").forEach(button => {
        const active = button.dataset.dock === state.dock;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
      requestAnimationFrame(updateWindowDock);
    };
    const floatPanel = () => {
      if (state.dock === "floating") return;
      const rect = panel.getBoundingClientRect();
      Object.assign(state, { dock: "floating", x: rect.left, y: rect.top, w: Math.min(620, rect.width), h: state.h ?? Math.round(rect.height) });
    };
    const setDock = dock => { if (dock === "floating") floatPanel(); state.dock = DOCKS.some(item => item[0] === dock) ? dock : "editor-top"; apply(); save(); };
    const track = (move, finish) => {
      const clean = () => { document.body.classList.remove("panel-dragging"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", clean); };
      const up = () => { clean(); finish(); };
      document.body.classList.add("panel-dragging");
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true }); window.addEventListener("pointercancel", clean, { once: true });
    };
    header.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest(".fp-actions,button")) return;
      event.preventDefault(); floatPanel(); apply();
      const offsetX = event.clientX - state.x, offsetY = event.clientY - state.y;
      let snap = null;
      const move = ev => {
        const chrome = chromeHeights();
        state.x = clamp(ev.clientX - offsetX, 36 - panel.offsetWidth, innerWidth - 36);
        state.y = clamp(ev.clientY - offsetY, chrome.header, innerHeight - chrome.footer - 28);
        Object.assign(panel.style, { left: `${state.x}px`, top: `${state.y}px` });
        snap = ev.clientY < chrome.header + SNAP + 6 ? "top" : ev.clientY > innerHeight - chrome.footer - SNAP - 6 ? "bottom" : null;
        snapTop.classList.toggle("active", snap === "top"); snapBottom.classList.toggle("active", snap === "bottom");
      };
      track(move, () => { snapTop.classList.remove("active"); snapBottom.classList.remove("active"); if (snap) setDock(`window-${snap}`); else save(); });
    });
    for (const handle of panel.querySelectorAll(".fp-handle")) handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const dir = handle.dataset.dir, rect = panel.getBoundingClientRect(), startX = event.clientX, startY = event.clientY;
      const base = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
      const move = ev => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        let { x, y, w, h } = base;
        if (dir.includes("e")) w = clamp(base.w + dx, 220, innerWidth - x);
        if (dir.includes("w")) { w = clamp(base.w - dx, 220, base.x + base.w); x = base.x + base.w - w; }
        if (dir.includes("s")) h = clamp(base.h + dy, minHeight(), heightLimit());
        if (dir.includes("n")) { h = clamp(base.h - dy, minHeight(), heightLimit()); y = base.y + base.h - h; }
        Object.assign(state, { x, y, w, h });
        if (state.dock === "floating") Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, width: `${w}px` });
        panel.style.height = `${h}px`; updateWindowDock();
      };
      track(move, save);
    });
    const setScale = (target, value) => {
      value = Math.round(clamp(value, MIN_SCALE, MAX_SCALE) * 100) / 100;
      if (target === "editor") editorScale = value; else state.scale = value;
      updateScale(target); updateWindowDock(); save();
    };
    actions.addEventListener("click", event => {
      const scaleButton = event.target.closest("[data-scale-action]");
      if (scaleButton) {
        const target = scaleButton.closest("[data-scale-target]").dataset.scaleTarget;
        setScale(target, (target === "editor" ? editorScale : state.scale) + (scaleButton.dataset.scaleAction === "larger" ? .1 : -.1));
      }
      const dockButton = event.target.closest(".fp-dock");
      if (dockButton) setDock(dockButton.dataset.dock);
    });
    for (const input of actions.querySelectorAll("[data-scale-input]")) {
      const restore = () => updateScale(input.dataset.scaleInput);
      const commit = () => { const match = input.value.trim().match(/^(\d+(?:\.\d+)?)\s*%?$/); const percent = match ? Number(match[1]) : NaN; if (percent >= 80 && percent <= 160) setScale(input.dataset.scaleInput, percent / 100); else restore(); };
      input.addEventListener("focus", () => input.select()); input.addEventListener("change", commit);
      input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); commit(); input.select(); } else if (event.key === "Escape") { event.preventDefault(); restore(); input.blur(); } });
      input.addEventListener("dblclick", () => { setScale(input.dataset.scaleInput, 1); input.select(); });
    }
    header.addEventListener("dblclick", event => { if (event.target.closest(".fp-actions,button")) return; Object.assign(state, { dock: "editor-top", x: 60, y: 96, w: 520, h: null }); apply(); save(); });
    let lastScaleTarget = "editor";
    actions.addEventListener("pointerdown", event => { const group = event.target.closest("[data-scale-target]"); if (group) lastScaleTarget = group.dataset.scaleTarget; }, true);
    const bindShortcuts = (targetDocument, fixedTarget = null) => {
      const shortcut = event => {
        const wheel = event.type === "wheel";
        if (!(event.ctrlKey || event.metaKey) || (!wheel && event.altKey)) return;
        const direction = wheel ? (event.deltaY < 0 ? 1 : -1) : ["Equal", "NumpadAdd"].includes(event.code) || event.key === "+" ? 1 : ["Minus", "NumpadSubtract"].includes(event.code) || event.key === "-" ? -1 : 0;
        if (!direction) return;
        const target = fixedTarget || (event.target.closest?.(".float-panel") ? "tag" : event.target.closest?.(options.editorSelector || "#monacoEditor,#visualEditor") ? "editor" : wheel ? null : lastScaleTarget);
        if (!target) return;
        lastScaleTarget = target; event.preventDefault(); if (!wheel) event.stopPropagation(); setScale(target, (target === "editor" ? editorScale : state.scale) + direction * .1);
      };
      targetDocument.addEventListener("wheel", shortcut, { capture: true, passive: false });
      targetDocument.addEventListener("keydown", shortcut, true);
    };
    bindShortcuts(document);
    if (options.editorReadyEvent) window.addEventListener(options.editorReadyEvent, event => {
      if (event.detail?.document) bindShortcuts(event.detail.document, "editor");
    });
    updateScale("editor"); apply();
    window.addEventListener("resize", () => { clampFloating(); updateWindowDock(); });
    window.addEventListener(options.chromeResizeEvent || "reader-chrome-resize", updateWindowDock);
    for (const eventName of options.layoutEvents || []) window.addEventListener(eventName, updateWindowDock);
    window.addEventListener("mew-tag-panel-reset", () => { editorScale = 1; Object.assign(state, { dock: "editor-top", x: 60, y: 96, w: 520, h: null, scale: 1 }); updateScale("editor"); apply(); save(); });
    return { panel, setDock, setScale, state };
  }
  window.MewTagPanel = { mount, tags, attrs, tagMap, blockTagNames, buildTagEdit, applyTag, insert };
})();
