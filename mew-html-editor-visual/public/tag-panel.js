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
    { id: "sub", label: "SUB", shortcut: "sub", open: "<sub>", close: "</sub>", title: "Insert Subscript" },
    { id: "u", label: "U", open: "<u>", close: "</u>", title: "Insert Underline" }
  ];
  const attrs = [
    { id: "idAttr", label: "ID=", text: " id=\"\"", cursorOffset: 5, title: "Insert id attribute" },
    { id: "classAttr", label: "CLASS=", text: " class=\"\"", cursorOffset: 8, title: "Insert class attribute" },
    { id: "styleAttr", label: "STYLE=", text: " style=\"\"", cursorOffset: 8, title: "Insert style attribute" },
    { id: "hrs", label: "HRS", text: "<hr style=\"width: 20%;\">", cursorOffset: 22, title: "Insert short hardline" },
    { id: "noIndentAttr", label: "NO INDENT", text: " style=\"text-indent: 0;\"", cursorOffset: 23, title: "Insert no-indent style attribute" },
    { id: "HR", label: "HR", text: "<hr>", cursorOffset: 3, title: "Insert hardline" },
    { id: "BR", label: "BR", text: "<br>", cursorOffset: 3, title: "Insert change line" },
    { id: "SUPdSUB", label: "SUP/SUB", text: "<sup></sup>/<sub></sub>", cursorOffset: 5, title: "Insert division" }
  ];
  const tagMap = new Map(tags.filter(tag => tag.shortcut).map(tag => [tag.shortcut.toLowerCase(), tag]));
  const blockTagNames = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6"]);
  const blockTagIds = new Set(["p", "r", "c", "h1", "h2", "h3", "h4", "h5", "h6", "div"]);
  const inlineTagIds = new Set(["i", "b", "u", "em", "span"])
  const voidTagNames = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const rawTagNames = new Set(["script", "style", "textarea", "title"]);
  const tagPattern = /<!--[\s\S]*?-->|<\/?[A-Za-z][\w:-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;

  class TagEditor {
    constructor(editor) {
      this.editor = editor;
      this.detect(editor.getValue());
    }

    detect(text) {
      if (this.text === text) return;
      const stack = [], pairs = [], byStart = new Map();
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
      for (const pair of pairs) {
        const align = pair.open.match(/\balign\s*=\s*["']?(center|right)\b/i)?.[1]?.toLowerCase();
        pair.id = pair.name === "p" ? align === "center" ? "c" : align === "right" ? "r" : "p" : pair.name;
        byStart.set(pair.start, pair);
      }
      this.text = text;
      this.detected = { pairs, byStart };
    }

    buildTagEdit(start, end, tag) {
      const text = this.text, { pairs, byStart } = this.detected;
      // Keep the selected line ending outside the edit, including both bytes of CRLF.
      const newline = text.slice(start, end).match(/\r?\n$/)?.[0] || "";
      end -= newline.length;
      const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      const nextLine = text.indexOf("\n", end);
      const lineEnd = nextLine < 0 ? text.length : nextLine;
      const wholeLine = start < end && !/\S/.test(text.slice(lineStart, start)) &&
        !/\S/.test(text.slice(end, lineEnd)) && !/[\r\n]/.test(text.slice(start, end));
      // A line selection may include indentation, trailing spaces and the next line's column 1.
      if (wholeLine) {
        const selected = text.slice(start, end), content = selected.trim();
        if (content) { start += selected.indexOf(content); end = start + content.length; }
      }
      const selected = text.slice(start, end);
      const name = /^<([A-Za-z][\w:-]*)\b/.exec(tag.open)?.[1].toLowerCase();
      const simple = name && tag.close.toLowerCase() === `</${name}>`;
      let cursor = start, found = false, block, same;
      while (cursor < end) {
        if (/\s/.test(text[cursor])) { cursor++; continue; }
        const pair = byStart.get(cursor);
        if (!pair || pair.end > end) break;
        found = true; cursor = pair.end;
      }
      const complete = found && cursor === end;
      const exact = complete && byStart.get(start)?.end === end && byStart.get(start);
      if (!complete) for (const pair of pairs) {
        if (!((start === end && pair.start < start && start < pair.openEnd) ||
          (pair.openEnd <= start && end <= pair.closeStart))) continue;
        if (blockTagIds.has(tag.id) && blockTagNames.has(pair.name) &&
          (!block || pair.end - pair.start < block.end - block.start)) block = pair;
        if (simple && pair.name === name && (!same || pair.end - pair.start < same.end - same.start)) same = pair;
      }
      const mismatched = exact && exact.closeName && exact.closeName !== exact.name;
      const isBlock = exact && blockTagNames.has(exact.name);
      const replaceBlock = isBlock && blockTagIds.has(tag.id) && (exact.id === tag.id || tag.id !== "div");
      const inlineInsert = isBlock && inlineTagIds.has(tag.id);
      const wrapper = exact ? (mismatched || replaceBlock || (simple && exact.name === name) || inlineInsert) && exact : block || same;
      if (wrapper) {
        const remove = mismatched ? name === wrapper.name : (replaceBlock || block) ? wrapper.id === tag.id : true;
        let open = remove ? "" : tag.open, close = remove ? "" : tag.close;
        const inner = text.slice(wrapper.openEnd, wrapper.closeStart);
        const inOpening = start === end && start < wrapper.openEnd;
        if (inlineInsert) {
          open = text.slice(start, wrapper.openEnd) + tag.open;
          close = tag.open + text.slice(wrapper.closeStart, byStart.get(start).end);
        }
        return { start: wrapper.start, end: wrapper.end, text: open + inner + close,
          selectStart: open.length + (exact || inOpening ? 0 : start - wrapper.openEnd),
          selectEnd: open.length + (exact ? inner.length : inOpening ? 0 : end - wrapper.openEnd) };
      }
      if (complete && tag.close && selected.startsWith(tag.open) && selected.endsWith(tag.close)) {
        const inner = selected.slice(tag.open.length, -tag.close.length);
        return { start, end, text: inner, selectStart: 0, selectEnd: inner.length };
      }
      const before = start - tag.open.length, after = end + tag.close.length;
      if (!complete && tag.close && before >= 0 && text.slice(before, start) === tag.open && text.slice(end, after) === tag.close) {
        return { start: before, end: after, text: selected, selectStart: 0, selectEnd: selected.length };
      }
      const replacement = tag.open + selected + tag.close, emptyAttribute = tag.open.indexOf('=""');
      cursor = emptyAttribute >= 0 ? emptyAttribute + 2 : selected ? replacement.length : tag.open.length;
      return { start, end, text: replacement, selectStart: complete ? tag.open.length : cursor,
        selectEnd: complete ? tag.open.length + selected.length : cursor };
    }

    applyTag(item) {
      const editor = this.editor;
      const tag = item.open !== undefined ? item : null;
      const text = editor.getValue(), selections = editor.selections?.() || [editor.selection()];
      if (tag) this.detect(text);
      const source = tag ? "mew.tag" : "mew.attr";
      const operations = selections.map(({ start, end }) => tag ? this.buildTagEdit(start, end, tag) : {
        start, end, text: item.text, selectStart: item.cursorOffset ?? item.text.length,
        selectEnd: item.cursorOffset ?? item.text.length
      });
      if (operations.length === 1) {
        const op = operations[0];
        editor.replaceRange(op.text, op.start, op.end, op.start + op.selectStart, op.start + op.selectEnd, source);
        if (tag) editor.editor?.revealRangeInCenterIfOutsideViewport(editor.editor.getSelection());
      } else {
        const edits = new Map(), targets = [];
        for (const operation of operations) {
          const pair = tag && this.detected.byStart.get(operation.start);
          const inner = pair && text.slice(pair.openEnd, pair.closeStart);
          const opening = tag?.open || "", closing = tag?.close || "";
          // Split wrapper changes so shared/nested multi-cursor edits preserve the inner text.
          if (pair?.end === operation.end && (operation.text === inner || operation.text === opening + inner + closing)) {
            const remove = operation.text === inner;
            edits.set(`${pair.start}:${pair.openEnd}`, { start: pair.start, end: pair.openEnd, text: remove ? "" : opening });
            edits.set(`${pair.closeStart}:${pair.end}`, { start: pair.closeStart, end: pair.end, text: remove ? "" : closing });
            targets.push({ start: pair.openEnd + operation.selectStart - (remove ? 0 : opening.length),
              end: pair.openEnd + operation.selectEnd - (remove ? 0 : opening.length) });
          } else {
            const key = `${operation.start}:${operation.end}`;
            if (!edits.has(key)) edits.set(key, operation);
            targets.push({ operation: edits.get(key) });
          }
        }
        const changes = [...edits.values()].sort((a, b) => a.start - b.start || a.end - b.end);
        const offset = (position, own) => position + changes.reduce((shift, edit) =>
          shift + (edit !== own && edit.end <= position ? edit.text.length - (edit.end - edit.start) : 0), 0);
        editor.replaceRanges(changes, targets.map(({ operation: op, start, end }) => op ? {
          start: offset(op.start, op) + op.selectStart, end: offset(op.start, op) + op.selectEnd
        } : { start: offset(start), end: offset(end) }), source);
      }
      editor.focus();
      return operations[0];
    }
  }

  const MIN_SCALE = .8, MAX_SCALE = 1.6, SNAP = 56;
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
    const state = Object.assign({ dock: "editor-top", x: 60, y: 96, w: 520, scale: 1 }, oldPanel);
    delete state.h; // Ignore heights saved before automatic content sizing.
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
    header.append(node("span", "fp-grip", "≡"), title);
    const hideButton = makeButton("×", "隐藏标签编辑框（Ctrl+Alt+M 重新打开）", "fp-hide");
    header.append(hideButton);
    hideButton.addEventListener("click", () => setVisible(false));
    content.classList.add("tag-bar");
    content.parentNode.insertBefore(panel, content);
    panel.append(header, content, actions);

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
    for (const dir of ["e", "w"]) {
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
    const save = () => {
      try { localStorage.setItem(options.storageKey, JSON.stringify({ dock: state.dock, x: Math.round(state.x), y: Math.round(state.y), w: Math.round(state.w), scale: state.scale, editorScale })); } catch {}
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
      panel.style.width = `${state.w}px`;
      const height = panel.getBoundingClientRect().height;
      state.x = options.keepFloatingInViewport
        ? clamp(state.x, 0, innerWidth - state.w)
        : clamp(state.x, 36 - state.w, innerWidth - 36);
      state.y = clamp(state.y, chrome.header, innerHeight - chrome.footer - (options.keepFloatingInViewport ? height : 28));
      Object.assign(panel.style, { left: `${state.x}px`, top: `${state.y}px`, width: `${state.w}px` });
    };
    const apply = () => {
      panel.className = `float-panel auto-height ${state.dock === "floating" ? "floating" : `dock-${state.dock}`}`;
      host.classList.toggle("bar-bottom", !panel.hidden && state.dock === "editor-bottom");
      host.classList.toggle("bar-fixed", panel.hidden || state.dock.startsWith("window-") || state.dock === "floating");
      panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = panel.style.width = "";
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
      Object.assign(state, { dock: "floating", x: rect.left, y: rect.top, w: Math.min(620, rect.width) });
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
      const dir = handle.dataset.dir, rect = panel.getBoundingClientRect(), startX = event.clientX;
      const move = ev => {
        const dx = ev.clientX - startX;
        state.w = dir === "e" ? clamp(rect.width + dx, 220, innerWidth - rect.left)
          : clamp(rect.width - dx, 220, rect.right);
        state.x = dir === "w" ? rect.right - state.w : rect.left;
        clampFloating(); updateWindowDock();
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
    header.addEventListener("dblclick", event => { if (event.target.closest(".fp-actions,button")) return; Object.assign(state, { dock: "editor-top", x: 60, y: 96, w: 520 }); apply(); save(); });
    let lastScaleTarget = "editor";
    actions.addEventListener("pointerdown", event => { const group = event.target.closest("[data-scale-target]"); if (group) lastScaleTarget = group.dataset.scaleTarget; }, true);
    const bindShortcuts = (targetDocument, fixedTarget = null) => {
      const shortcut = event => {
        if (!event.isComposing && event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey && event.code === "KeyM") {
          event.preventDefault(); event.stopPropagation(); setVisible(true); return;
        }
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
    new ResizeObserver(() => {
      clampFloating();
      updateWindowDock();
    }).observe(panel);
    window.addEventListener("resize", () => { clampFloating(); updateWindowDock(); });
    window.addEventListener(options.chromeResizeEvent || "reader-chrome-resize", updateWindowDock);
    for (const eventName of options.layoutEvents || []) window.addEventListener(eventName, updateWindowDock);
    window.addEventListener("mew-tag-panel-reset", () => { editorScale = 1; Object.assign(state, { dock: "editor-top", x: 60, y: 96, w: 520, scale: 1 }); updateScale("editor"); apply(); save(); });
    const toggle = document.getElementById("tagPanelToggle");
    if (toggle) {
      toggle.title = "打开标签编辑框（Ctrl+Alt+T）";
      toggle.setAttribute("aria-keyshortcuts", "Control+Alt+T");
    }
    const setVisible = visible => {
      panel.hidden = !visible;
      host.classList.toggle("bar-bottom", visible && state.dock === "editor-bottom");
      host.classList.toggle("bar-fixed", !visible || state.dock.startsWith("window-") || state.dock === "floating");
      if (toggle) {
        toggle.textContent = `${visible ? "隐藏" : "打开"}标签编辑框`;
        toggle.setAttribute("aria-expanded", String(visible));
      }
      updateWindowDock();
    };
    toggle?.addEventListener("click", () => setVisible(panel.hidden));
    return { panel, setDock, setScale, setVisible, state };
  }
  window.MewTagPanel = { mount, tags, attrs, tagMap, blockTagNames, TagEditor };
})();
