(() => {
  "use strict";
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
  window.MewTagPanel = { mount };
})();
