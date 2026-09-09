const $ = id => document.getElementById(id);
const state = { path: "", docs: new Map(), opening: new Map(), navigation: 0, checkingTree: false, cssText: "" };
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
const tagMap = Object.fromEntries(tags.map(tag => [tag.shortcut, tag]));
const attrs = [
  { id: "idAttr", label: "ID=", text: " id=\"\"", cursorOffset: 5, title: "Insert id attribute" },
  { id: "classAttr", label: "CLASS=", text: " class=\"\"", cursorOffset: 8, title: "Insert class attribute" },
  { id: "styleAttr", label: "STYLE=", text: " style=\"\"", cursorOffset: 8, title: "Insert style attribute" },
  { id: "hrs", label: "HRS", text: "<hr style=\"width: 20%;\">", cursorOffset: 22, title: "Insert short hardline" },
  { id: "noIndentAttr", label: "NO INDENT", text: " style=\"text-indent: 0;\"", cursorOffset: 23, title: "Insert no-indent style attribute" },
  { id: "HR", label: "HR", text: "<hr>", cursorOffset: 3, title: "Insert hardline" },
  { id: "BR", label: "BR", text: "<br>", cursorOffset: 3, title: "Insert change line" }
];
const BLOCK_IDS = new Set(["p", "r", "c", "h1", "h2", "h3", "h4", "h5", "h6", "div"]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TAGS = new Set(["script", "style", "textarea", "title"]);
const TAG_PATTERN = /<!--[\s\S]*?-->|<\/?[A-Za-z][\w:-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const UNDO_LIMIT = 100;
const UNDO_CHAR_LIMIT = 10_000_000;
const PREVIEW_DELAY = 200;
const TAG_PANEL_KEY = "mewTagPanel.v1";
let highlightFrame = 0;
let previewTimer = 0;
function api(url, options) {
  return fetch(url, options).then(async r => {
    const type = r.headers.get("content-type") || "";
    const data = type.includes("json") ? await r.json() : await r.text();
    if (!r.ok || data.error) throw new Error(data.error || data);
    return data;
  });
}
function postJson(url, data) {
  return api(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data)
  });
}
function note(msg) { $("status").textContent = msg; setTimeout(() => { if ($("status").textContent === msg) $("status").textContent = ""; }, 2500); }
function esc(s) { return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c])); }
function fileLabel(path) { return path.split("/").pop() || path || "Untitled"; }
function doc() { return state.docs.get(state.path); }
function editorSnapshot(ed = $("editor")) {
  return { text: ed.value, a: ed.selectionStart, b: ed.selectionEnd };
}
function restoreEditorSnapshot(snap, ed = $("editor")) {
  ed.value = snap.text;
  ed.focus();
  ed.setSelectionRange(snap.a, snap.b);
}
function themeColors() {
  const style = getComputedStyle(document.body);
  return {
    bg: style.getPropertyValue("--bg").trim(),
    ink: style.getPropertyValue("--ink").trim()
  };
}
function saveSnapshot(d, text = d.value) {
  const pending = (d.saving || Promise.resolve()).then(async () => {
    if (text === d.text) return;
    const data = await postJson("/api/save", { path: d.path, text, mtime: d.mtime });
    d.text = text; d.mtime = data.mtime; d.dirty = d.value !== text;
  });
  d.saving = pending;
  return pending.finally(() => { if (d.saving === pending) d.saving = null; });
}
function persistEditor() {
  const d = doc();
  if (!d) return;
  const ed = $("editor");
  d.value = ed.value; d.selA = ed.selectionStart; d.selB = ed.selectionEnd;
  d.top = ed.scrollTop; d.left = ed.scrollLeft;
  d.dirty = d.value !== d.text;
}
function markDirty(v, forceTabs = false) {
  const d = doc();
  if (!d) {
    $("fileName").textContent = "No file open";
    renderTabs();
    return;
  }
  d.value = $("editor").value;
  const wasDirty = d.dirty;
  d.dirty = v ?? d.value !== d.text;
  $("fileName").textContent = d.path + (d.dirty ? " *" : "");
  if (forceTabs || wasDirty !== d.dirty) renderTabs();
}
function scheduleEditorRefresh() {
  if (!highlightFrame) {
    highlightFrame = requestAnimationFrame(() => {
      highlightFrame = 0;
      updateHighlight();
    });
  }
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, PREVIEW_DELAY);
}
function commitEditorChange() {
  markDirty();
  scheduleEditorRefresh();
}
function refreshDocumentView() {
  cancelAnimationFrame(highlightFrame);
  highlightFrame = 0;
  refreshPreview();
  findAll();
  updateHighlight();
}
function setActiveTreePath(path = "") {
  document.querySelectorAll(".item.active").forEach(item => item.classList.remove("active"));
  if (path) document.querySelector(`.item[data-path="${CSS.escape(path)}"]`)?.classList.add("active");
}
function trimUndo(d) {
  while (d.undo.length > UNDO_LIMIT || d.undoSize > UNDO_CHAR_LIMIT) {
    d.undoSize -= d.undo.shift().text.length;
  }
}
function renderTabs() {
  $("editor").disabled = !doc();
  const tabs = $("tabs");
  tabs.innerHTML = [...state.docs.values()].map(d => `
    <button class="tab${d.path === state.path ? " active" : ""}" data-path="${esc(d.path)}" title="${esc(d.path)}">
      <span class="tabName">${esc(fileLabel(d.path))}${d.dirty ? " *" : ""}</span>
      <span class="tabClose" data-close="${esc(d.path)}" title="Close">x</span>
    </button>
  `).join("");
  tabs.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function remember() {
  const ed = $("editor"), d = doc();
  if (!d) return;
  d.inputGroup = null;
  const last = d.undo[d.undo.length - 1];
  const snap = editorSnapshot(ed);
  if (!last || last.text !== snap.text || last.a !== snap.a || last.b !== snap.b) {
    d.undo.push(snap);
    d.undoSize += snap.text.length;
    trimUndo(d);
  }
  d.redo = [];
}
function undo() {
  const ed = $("editor"), d = doc(), snap = d?.undo.pop();
  if (!snap) return note("Nothing to undo");
  d.inputGroup = null;
  d.undoSize -= snap.text.length;
  d.redo.push(editorSnapshot(ed));
  restoreEditorSnapshot(snap, ed);
  commitEditorChange(); note("Undone");
}
function redo() {
  const ed = $("editor"), d = doc(), snap = d?.redo.pop();
  if (!snap) return note("Nothing to redo");
  d.inputGroup = null;
  const current = editorSnapshot(ed);
  d.undo.push(current);
  d.undoSize += current.text.length;
  trimUndo(d);
  restoreEditorSnapshot(snap, ed);
  commitEditorChange(); note("Redone");
}

async function loadTree(rel = "", host = $("tree"), open = new Set()) {
  const data = await api(`/api/tree?path=${encodeURIComponent(rel)}`);
  $("rootPath").textContent = data.root;
  const box = rel ? document.createElement("div") : host;
  if (rel) box.className = "indent";
  box.innerHTML = "";
  for (const e of data.entries) {
    const row = document.createElement("div");
    row.className = "item";
    row.dataset.path = e.path;
    row.dataset.type = e.type;
    row.title = e.type === "file" ? "Click to open in this window." : "Click to expand.";
    row.innerHTML = `<span>${e.type === "dir" ? "+" : "-"}</span><span class="name">${esc(e.name)}</span>`;
    row.tabIndex = 0;
    if (e.type === "dir") row.setAttribute("aria-expanded", String(open.has(e.path)));
    box.append(row);
    if (e.type === "dir" && open.has(e.path)) {
      row.firstChild.textContent = "-";
      await loadTree(e.path, row, open);
    }
  }
  if (rel) host.after(box);
  box.querySelector(`.item[data-path="${CSS.escape(state.path)}"]`)?.classList.add("active");
}
async function toggleDir(row, rel) {
  if (row.dataset.loading) return;
  const next = row.nextElementSibling;
  if (next?.classList.contains("indent")) {
    next.remove(); row.firstChild.textContent = "+"; row.setAttribute("aria-expanded", "false"); return;
  }
  row.dataset.loading = "1";
  try {
    await loadTree(rel, row);
    row.firstChild.textContent = "-"; row.setAttribute("aria-expanded", "true"); filterTree();
  } catch (e) { note(e.message); }
  finally { delete row.dataset.loading; }
}
function openDirs() {
  return new Set([...document.querySelectorAll(".item[data-type='dir']")]
    .filter(row => row.nextElementSibling?.classList.contains("indent"))
    .map(row => row.dataset.path));
}
async function refreshTree() {
  if (state.checkingTree) {
    clearTimeout(treeRefreshTimer);
    treeRefreshTimer = setTimeout(refreshTree, 80);
    return;
  }
  state.checkingTree = true;
  try {
    const open = openDirs();
    const nextTree = document.createElement("div");
    await loadTree("", nextTree, open);
    // Expansion may have changed while the detached tree was loading.
    if ([...openDirs()].join("\n") !== [...open].join("\n")) {
      treeRefreshTimer = setTimeout(refreshTree, 80); return;
    }
    const focusPath = document.activeElement?.dataset.path, top = $("tree").scrollTop;
    $("tree").replaceChildren(...nextTree.childNodes);
    filterTree(); setActiveTreePath(state.path);
    if (focusPath) $("tree").querySelector(`[data-path="${CSS.escape(focusPath)}"]`)?.focus();
    $("tree").scrollTop = top;
  } catch (e) {
    note(e.message);
  } finally {
    state.checkingTree = false;
  }
}
async function openFile(rel) {
  const revision = ++state.navigation;
  try {
    if (!state.docs.has(rel)) {
      if (!state.opening.has(rel)) state.opening.set(rel, api(`/api/file?path=${encodeURIComponent(rel)}`)
        .finally(() => state.opening.delete(rel)));
      const data = await state.opening.get(rel);
      if (!state.docs.has(data.path)) state.docs.set(data.path, { ...data, value: data.text, dirty: false, matches: [], match: -1, undo: [], undoSize: 0, redo: [] });
      rel = data.path;
    }
    if (revision === state.navigation) switchDoc(rel);
    else renderTabs();
  } catch (e) { note(e.message); }
}
async function openSiblingFile(direction) {
  if (!state.path) return note("Open a file first");
  const parts = state.path.split("/");
  const currentName = parts.pop();
  const dir = parts.join("/");
  try {
    const data = await api(`/api/tree?path=${encodeURIComponent(dir)}`);
    const files = data.entries.filter(entry => entry.type === "file");
    const currentIndex = files.findIndex(entry => entry.name === currentName);
    if (currentIndex < 0 || files.length < 2) return note("No other file in this folder");
    const target = files[(currentIndex + direction + files.length) % files.length];
    await openFile(target.path);
  } catch (e) {
    note(e.message);
  }
}
function switchDoc(path) {
  ++state.navigation;
  persistEditor();
  const d = state.docs.get(path);
  if (!d) return;
  d.inputGroup = null;
  state.path = path;
  $("editor").value = d.value;
  setActiveTreePath(path);
  markDirty(d.dirty, true); refreshDocumentView(); $("editor").focus();
  $("editor").setSelectionRange(d.selA || 0, d.selB || 0);
  $("editor").scrollTop = d.top || 0; $("editor").scrollLeft = d.left || 0;
  syncHighlightScroll();
}
async function closeDocs(paths) {
  if ($("closeDialog").open) return;
  persistEditor();
  ++state.navigation;
  let next = state.path;
  for (const path of paths) {
    const d = state.docs.get(path);
    if (!d) continue;
    if (d.dirty || d.saving) {
      const choice = await closeChoice(d.path);
      if (choice === "cancel") break;
      try {
        if (d.saving) await d.saving;
        if (choice === "save") await saveSnapshot(d);
      } catch (e) { note(e.message); break; }
      if (choice === "save" && d.dirty) { note("Newer edits remain unsaved"); break; }
    }
    if (next === path) {
      const keys = [...state.docs.keys()], i = keys.indexOf(path);
      next = keys[i + 1] || keys[i - 1] || "";
    }
    state.docs.delete(path);
  }
  if (next !== state.path) {
    state.path = "";
    if (next) switchDoc(next);
    else {
      $("editor").value = "";
      $("preview").srcdoc = "";
      setActiveTreePath();
      markDirty(false); refreshDocumentView();
    }
  } else {
    renderTabs();
  }
}
function closeChoice(path) {
  const dialog = $("closeDialog");
  $("closeMessage").textContent = `Save changes to ${path}?`;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true }));
}
async function closeAll(savedOnly = false) {
  await closeDocs([...state.docs.values()].filter(d => !savedOnly || (!d.dirty && !d.saving)).map(d => d.path));
  note(savedOnly ? "Closed saved windows" : state.docs.size ? "Some windows remain open" : "Closed all windows");
}
function openFileWindow() {
  if (!state.path) return note("Open a file first");
  window.open(`/?file=${encodeURIComponent(state.path)}`, "_blank");
}
const saveAll = () => save(true);
async function save(all = false) {
  persistEditor();
  const docs = all === true ? [...state.docs.values()] : [doc()].filter(Boolean);
  if (!docs.length) return note("Open a file first");
  try {
    await Promise.all(docs.map(d => saveSnapshot(d)));
    note(docs.some(d => d.dirty) ? "Saved; newer edits remain unsaved" : "Saved");
  } catch (e) { note(e.message); }
  finally { markDirty(undefined, true); }
}
function refreshPreview() {
  clearTimeout(previewTimer);
  if (!state.path) return;
  const dir = state.path.split("/").slice(0, -1).join("/");
  const { bg, ink } = themeColors();
  const css = `${state.cssText ? `<style>${state.cssText}</style>` : '<link rel="stylesheet" href="/mewde.css">'}<style>body{background:${bg};color:${ink}}</style>`;
  const base = `<base href="/raw/${encodeURI(dir)}${dir ? "/" : ""}">`;
  $("preview").srcdoc = base + css + $("editor").value;
}
function openRaw() {
  if (state.path) {
    const { bg, ink } = themeColors();
    window.open(`/raw/${encodeURI(state.path)}?bg=${encodeURIComponent(bg)}&fg=${encodeURIComponent(ink)}`, "_blank");
  }
}
function editTag(tag) {
  const ed = $("editor"), start = ed.selectionStart, end = ed.selectionEnd;
  remember();
  const operation = buildTagEdit(ed.value, start, end, tag);
  const before = ed.value.slice(operation.start, operation.end);
  ed.setRangeText(operation.text, operation.start, operation.end, "select");
  ed.setSelectionRange(operation.start + operation.selectStart, operation.start + operation.selectEnd);
  const action = operation.text.length < before.length ? "Removed"
    : operation.start !== start || operation.end !== end ? "Replaced with" : "Inserted";
  ed.focus(); commitEditorChange(); note(`${action} ${tag.label}`);
}

function buildTagEdit(text, start, end, tag) {
  const elements = tagPairs(text);
  const selected = text.slice(start, end);
  const name = tagName(tag.open);
  const complete = start < end && isCompleteSelection(text, elements, start, end);
  const exact = complete && elements.find(element => element.start === start && element.end === end);

  if (complete) {
    // 错配闭合标签：以前面的开始标签为准。点击同类标签删除，
    // 点击其他标签则直接替换整个外层，而不是再包一层。
    if (exact && exact.closeName && exact.closeName !== exact.name) {
      if (name === exact.name) return changeWrapper(text, exact, start, end);
      return changeWrapper(text, exact, start, end, tag);
    }
    if (exact && isBlock(exact) && BLOCK_IDS.has(tag.id)) {
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

  const block = BLOCK_IDS.has(tag.id) && innermost(elements.filter(isBlock), start, end);
  if (block) return changeWrapper(text, block, start, end, blockId(block) === tag.id ? undefined : tag);

  const same = name && isSimplePair(tag) && innermost(elements.filter(element => element.name === name), start, end);
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
    .filter(element => (start === end && element.start < start && start < element.openEnd) ||
      (element.openEnd <= start && end <= element.closeStart))
    .reduce((inner, element) => !inner || element.end - element.start < inner.end - inner.start ? element : inner, undefined);
}

function isCompleteSelection(text, elements, start, end) {
  let cursor = skipSpace(text, start, end), found = false;
  while (cursor < end) {
    const outer = elements
      .filter(element => element.start === cursor && element.end <= end)
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
  TAG_PATTERN.lastIndex = 0;
  for (let match; (match = TAG_PATTERN.exec(text));) {
    const token = match[0];
    if (token.startsWith("<!--")) continue;
    const name = token.match(/^<\/?([A-Za-z][\w:-]*)/i)[1].toLowerCase();
    const closing = /^<\//.test(token);

    if (rawName && !(closing && name === rawName)) continue;
    if (closing) {
      const open = stack[stack.length - 1];
      if (open?.name !== name) {
        const crossed = stack.findLastIndex(item => item.name === name);
        // 交叉标签截断栈；没有同名开始标签时，按最近的开始标签容错配对。
        if (crossed >= 0) { stack.length = crossed; continue; }
      }
      if (open) {
        stack.pop();
        pairs.push({ name: open.name, closeName: name, start: open.start, openEnd: open.end, closeStart: match.index, end: TAG_PATTERN.lastIndex, open: open.token });
        if (name === rawName) rawName = undefined;
      }
    } else if (VOID_TAGS.has(name) || /\/\s*>$/.test(token)) {
      pairs.push({ name, start: match.index, openEnd: TAG_PATTERN.lastIndex, closeStart: TAG_PATTERN.lastIndex, end: TAG_PATTERN.lastIndex, open: token });
    } else {
      stack.push({ name, start: match.index, end: TAG_PATTERN.lastIndex, token });
      if (RAW_TAGS.has(name)) rawName = name;
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

function insertAttr(attr) {
  const ed = $("editor"), a = ed.selectionStart, b = ed.selectionEnd;
  remember();
  ed.setRangeText(attr.text, a, b, "end");
  ed.focus();
  ed.setSelectionRange(a + attr.cursorOffset, a + attr.cursorOffset);
  commitEditorChange(); note(`Inserted ${attr.label}`);
}
function buildTagBar() {
  $("tagBar").innerHTML = [
    ...tags.map((tag, i) => `<button class="tag" data-i="${i}" title="${esc(tag.title)}">${esc(tag.label)}</button>`),
    ...attrs.map((attr, i) => `<button class="tag attrTag" data-attr="${i}" title="${esc(attr.title)}">${esc(attr.label)}</button>`),
    '<button class="tag attrTag" data-nav="-1" title="Open previous file in folder">←</button>',
    '<button class="tag attrTag" data-nav="1" title="Open next file in folder">→</button>'
  ].join("");
  $("tagBar").onclick = e => {
    const tag = e.target.closest("button[data-i]");
    const attr = e.target.closest("button[data-attr]");
    const nav = e.target.closest("button[data-nav]");
    if (tag) editTag(tags[Number(tag.dataset.i)]);
    if (attr) insertAttr(attrs[Number(attr.dataset.attr)]);
    if (nav) openSiblingFile(Number(nav.dataset.nav));
  };
}

function setupTagPanel() {
  const pane = document.querySelector(".editorPane");
  const panel = $("tagPanel");
  const grip = $("tagPanelGrip");
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(TAG_PANEL_KEY) || "{}"); } catch {}

  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  const persist = dock => localStorage.setItem(TAG_PANEL_KEY, JSON.stringify({ dock, x: panel.offsetLeft, y: panel.offsetTop }));
  const placeFloating = (x, y) => {
    const maxX = pane.clientWidth - panel.offsetWidth - 8;
    const maxY = pane.clientHeight - panel.offsetHeight - 8;
    panel.style.left = `${clamp(x, 8, maxX)}px`;
    panel.style.top = `${clamp(y, 8, maxY)}px`;
  };
  const setDock = (dock, x = saved.x ?? 16, y = saved.y ?? 50) => {
    if (!["top", "bottom", "floating"].includes(dock)) dock = "top";
    panel.className = `tagPanel ${dock === "floating" ? "floating" : `dock-${dock}`}`;
    panel.style.left = panel.style.top = "";
    if (dock === "floating") requestAnimationFrame(() => {
      placeFloating(x, y);
      persist(dock);
    });
    panel.querySelectorAll("[data-tag-dock]").forEach(button => button.classList.toggle("active", button.dataset.tagDock === dock));
    if (dock !== "floating") persist(dock);
  };

  panel.addEventListener("click", event => {
    const button = event.target.closest("[data-tag-dock]");
    if (button) setDock(button.dataset.tagDock);
  });
  grip.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.target.closest("button")) return;
    event.preventDefault();
    const paneRect = pane.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const dx = event.clientX - panelRect.left;
    const dy = event.clientY - panelRect.top;
    if (!panel.classList.contains("floating")) setDock("floating", panelRect.left - paneRect.left, panelRect.top - paneRect.top);
    grip.setPointerCapture(event.pointerId);
    const move = moveEvent => placeFloating(moveEvent.clientX - paneRect.left - dx, moveEvent.clientY - paneRect.top - dy);
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      persist("floating");
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  window.addEventListener("resize", () => {
    if (panel.classList.contains("floating")) placeFloating(panel.offsetLeft, panel.offsetTop);
  });
  setDock(saved.dock || "top", saved.x, saved.y);
}
function makePattern() {
  const q = $("findText").value;
  if (!q) return null;
  return new RegExp($("regexBox").checked ? q : reEsc(q), $("caseBox").checked ? "g" : "gi");
}
function findAll() {
  const d = doc();
  if (!d) { $("findInfo").textContent = ""; return; }
  const prev = d.match;
  d.matches = [];
  let re; try { re = makePattern(); } catch (e) { $("findInfo").textContent = e.message; return; }
  if (!re) { d.match = -1; $("findInfo").textContent = ""; return; }
  const text = $("editor").value; let m;
  while ((m = re.exec(text))) { d.matches.push([m.index, m.index + m[0].length]); if (m[0] === "") re.lastIndex++; }
  d.match = Math.min(prev, d.matches.length - 1);
  $("findInfo").textContent = `${d.matches.length} match${d.matches.length === 1 ? "" : "es"}`;
}
function gotoMatch() {
  findAll();
  const d = doc();
  if (!d?.matches.length) return;
  d.match = (d.match + 1) % d.matches.length;
  const [a, b] = d.matches[d.match], ed = $("editor");
  ed.focus(); ed.setSelectionRange(a, b); scrollSelectionIntoView(ed, a); $("findInfo").textContent = `${d.match + 1}/${d.matches.length}`;
}
function scrollSelectionIntoView(ed, pos) {
  const wrap = ed.parentElement;
  const cs = getComputedStyle(ed);
  const mirror = document.createElement("div");
  const marker = document.createElement("span");
  mirror.style.cssText = `
    position:absolute; visibility:hidden; inset:0 auto auto 0;
    width:${ed.clientWidth}px; min-height:${ed.clientHeight}px;
    padding:${cs.padding}; border:0; margin:0; box-sizing:border-box;
    overflow-wrap:break-word; word-wrap:break-word; white-space:pre-wrap;
    font:${cs.font}; line-height:${cs.lineHeight}; letter-spacing:${cs.letterSpacing}; tab-size:${cs.tabSize};
  `;
  mirror.textContent = ed.value.slice(0, pos);
  marker.textContent = "\u200b";
  mirror.append(marker);
  wrap.append(mirror);
  ed.scrollTop = Math.max(0, marker.offsetTop - ed.clientHeight / 2);
  ed.scrollLeft = Math.max(0, marker.offsetLeft - ed.clientWidth / 2);
  mirror.remove();
  syncHighlightScroll();
}
function replaceOne() {
  const d = doc();
  if (!d) return;
  if (d.match < 0) gotoMatch();
  const ed = $("editor"), [a, b] = d.matches[d.match] || [];
  if (a == null) return;
  remember();
  ed.setRangeText($("replaceText").value, a, b, "end"); commitEditorChange(); gotoMatch();
}
function replaceAll() {
  let re; try { re = makePattern(); } catch (e) { return $("findInfo").textContent = e.message; }
  if (!re) return;
  const ed = $("editor"), before = ed.value;
  const count = (before.match(re) || []).length;
  remember();
  ed.value = before.replace(re, $("replaceText").value);
  commitEditorChange(); findAll(); $("findInfo").textContent = `Replaced ${count}`;
}
function filterTree() {
  const q = $("treeFilter").value.toLowerCase();
  document.querySelectorAll("#tree .item").forEach(row => {
    row.hidden = row.dataset.type === "file" && !row.dataset.path.toLowerCase().includes(q);
  });
}
async function revealFile() {
  const parts = state.path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const row = $("tree").querySelector(`[data-path="${CSS.escape(parts.slice(0, i).join("/"))}"]`);
    if (row && row.getAttribute("aria-expanded") !== "true") await toggleDir(row, row.dataset.path);
  }
  $("treeFilter").value = ""; filterTree(); setActiveTreePath(state.path);
  $("tree").querySelector(".active")?.focus();
}
function treeKeydown(e) {
  const row = e.target.closest(".item");
  if (!row || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(e.key)) return;
  e.preventDefault();
  const rows = [...$("tree").querySelectorAll(".item")].filter(item => !item.hidden), i = rows.indexOf(row);
  const expanded = row.getAttribute("aria-expanded") === "true";
  if (e.key === "Enter" || e.key === " ") row.click();
  else if (e.key === "ArrowRight" && row.dataset.type === "dir" && !expanded) toggleDir(row, row.dataset.path);
  else if (e.key === "ArrowLeft") {
    if (expanded) toggleDir(row, row.dataset.path);
    else row.parentElement.closest(".indent")?.previousElementSibling?.focus();
  } else rows[e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowUp" ? -1 : 1)))]?.focus();
}
function keydown(e) {
  if (e.defaultPrevented || e.isComposing || $("closeDialog").open) return;
  const inEditor = document.activeElement === $("editor");
  if (inEditor && e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const ed = $("editor"), a = ed.selectionStart, b = ed.selectionEnd;
    remember();
    if (a === b && !e.shiftKey) ed.setRangeText("  ", a, b, "end");
    else {
      const start = ed.value.lastIndexOf("\n", a - 1) + 1;
      const end = b > a && ed.value[b - 1] === "\n" ? b - 1 : b;
      const lines = ed.value.slice(start, end).split("\n");
      const changed = lines.map(line => e.shiftKey ? line.replace(/^( {1,2}|\t)/, "") : "  " + line);
      const text = changed.join("\n");
      ed.setRangeText(text, start, end, "select");
      ed.setSelectionRange(Math.max(start, a + changed[0].length - lines[0].length), b + text.length - (end - start));
    }
    commitEditorChange(); return;
  }
  if (e.ctrlKey || e.metaKey) {
    const commands = { s: () => save(e.shiftKey), f: () => $("findText").focus(), h: () => $("replaceText").focus(), w: () => closeDocs([state.path]),
      ...(inEditor ? { z: e.shiftKey ? redo : undo, y: redo } : {}) };
    const action = commands[e.key.toLowerCase()];
    if (action) { e.preventDefault(); action(); return; }
    if (e.key === "Tab" && state.docs.size) {
      e.preventDefault();
      const paths = [...state.docs.keys()], i = paths.indexOf(state.path);
      switchDoc(paths[(i + (e.shiftKey ? -1 : 1) + paths.length) % paths.length]); return;
    }
  }
  if (inEditor && (e.altKey || $("instant").checked) && !e.ctrlKey && !e.metaKey) {
    const k = e.key.toLowerCase();
    if (tagMap[k]) { e.preventDefault(); editTag(tagMap[k]); }
  }
}
function setDark(on) {
  document.body.classList.toggle("dark", on);
  localStorage.setItem("mewDark", on ? "1" : "0");
  $("darkBtn").textContent = on ? "Light" : "Dark";
}
function attrToken(raw, value) {
  const link = raw.match(/^\s*href\s*=\s*(["'])([\s\S]*?)\1$/i);
  if (link) return `<span class="tok-string">${esc(link[1])}</span><span class="tok-link" title="Ctrl+click to open">${esc(link[2])}</span><span class="tok-string">${esc(link[1])}</span>`;
  return `<span class="tok-string">${esc(value)}</span>`;
}
function colorTag(raw) {
  if (raw.startsWith("<!--")) return `<span class="tok-comment">${esc(raw)}</span>`;
  let out = "", last = 0;
  const re = /(<\/?)([A-Za-z][\w:-]*)|([\w:-]+)(\s*=\s*)("[^"]*"|'[^']*')|([<>/=])/g;
  for (let m; (m = re.exec(raw));) {
    out += esc(raw.slice(last, m.index));
    if (m[1]) out += `<span class="tok-punct">${esc(m[1])}</span><span class="tok-tag">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-attr">${esc(m[3])}</span><span class="tok-punct">${esc(m[4])}</span>${attrToken(m[0], m[5])}`;
    else if (m[6]) out += `<span class="tok-punct">${esc(m[6])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(raw.slice(last));
}
function highlightHtml(text) {
  let out = "", last = 0;
  const re = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*?>/g;
  for (let m; (m = re.exec(text));) {
    out += esc(text.slice(last, m.index)) + colorTag(m[0]);
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last)) + (text.endsWith("\n") ? " " : "");
}
function updateHighlight() {
  $("highlight").innerHTML = highlightHtml($("editor").value);
  syncHighlightScroll();
}
function syncHighlightScroll() {
  $("highlight").scrollTop = $("editor").scrollTop;
  $("highlight").scrollLeft = $("editor").scrollLeft;
}
function linkAt(pos) {
  const text = $("editor").value;
  const lower = text.toLowerCase();
  const open = lower.lastIndexOf("<a", pos);
  const close = lower.lastIndexOf("</a", pos);
  const tagEnd = open >= 0 ? text.indexOf(">", open) : -1;
  if (open < 0 || close > open || tagEnd < 0) return "";
  const end = text.indexOf("</a", tagEnd);
  if (pos > tagEnd && (end < 0 || pos > end)) return "";
  const tag = text.slice(open, tagEnd + 1);
  const href = tag.match(/\shref\s*=\s*(["'])(.*?)\1/i);
  return href ? href[2] : "";
}
function reEsc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function gotoAnchor(fragment) {
  const id = decodeURIComponent(fragment.replace(/^#/, ""));
  if (!id) return false;
  const ed = $("editor");
  const re = new RegExp(`\\bid\\s*=\\s*(["'])${reEsc(id)}\\1`, "i");
  const m = re.exec(ed.value);
  if (!m) return false;
  const quote = ed.value.indexOf(m[1], m.index);
  const a = quote + 1, b = a + id.length;
  ed.focus();
  ed.setSelectionRange(a, b);
  scrollSelectionIntoView(ed, a);
  note(`Jumped to #${id}`);
  return true;
}
function openEditorLink(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  const ed = $("editor");
  const href = linkAt(ed.selectionStart);
  if (!href) return;
  e.preventDefault();
  if (href.startsWith("#")) {
    if (!gotoAnchor(href)) note(`Anchor not found: ${href}`);
    return;
  }
  const dir = state.path.split("/").slice(0, -1).join("/");
  const base = state.path ? `/raw/${encodeURI(dir)}${dir ? "/" : ""}` : location.href;
  window.open(new URL(href, location.origin + base).href, "_blank");
}
function applyExternalUpdate(d, data) {
  d.text = data.text;
  d.value = data.text;
  d.mtime = data.mtime;
  d.dirty = false;
  d.undo = [];
  d.undoSize = 0;
  d.redo = [];
  if (d.path !== state.path) return renderTabs();
  const ed = $("editor");
  const a = Math.min(ed.selectionStart, data.text.length), b = Math.min(ed.selectionEnd, data.text.length);
  ed.value = data.text;
  ed.setSelectionRange(a, b);
  markDirty(false); refreshDocumentView();
  note(`Updated ${d.path}`);
}
const externalCheckTimers = new Map();
let treeRefreshTimer = 0;
async function checkExternalUpdate(path) {
  const d = state.docs.get(path);
  if (!d) return;
  if (d.saving) { scheduleExternalUpdate(path); return; }
  const baseline = d.text, mtime = d.mtime;
  try {
    const data = await api(`/api/file?path=${encodeURIComponent(d.path)}`);
    if (state.docs.get(path) !== d) return;
    if (d.saving || d.text !== baseline || d.mtime !== mtime) { scheduleExternalUpdate(path); return; }
    if (data.mtime === d.mtime) return;
    const localValue = d.path === state.path ? $("editor").value : d.value;
    if (data.text === d.text) { d.mtime = data.mtime; return; }
    if (data.text === localValue) {
      d.text = data.text;
      d.value = data.text;
      d.mtime = data.mtime;
      d.dirty = false;
      if (d.path === state.path) markDirty(false);
      else renderTabs();
      return;
    }
    if (d.dirty || localValue !== d.text) note(`External update pending for ${d.path}; save or close local edits first`);
    else applyExternalUpdate(d, data);
  } catch (e) {
    note(`External file unavailable: ${d.path}`);
  }
}
function scheduleExternalUpdate(path) {
  clearTimeout(externalCheckTimers.get(path));
  externalCheckTimers.set(path, setTimeout(() => {
    externalCheckTimers.delete(path);
    checkExternalUpdate(path);
  }, 80));
}
function connectFileEvents() {
  const events = new EventSource("/api/events");
  events.onmessage = event => {
    let change;
    try { change = JSON.parse(event.data); } catch { return; }
    if (change.event === "ready") return;
    if (change.path === "mewde.css") checkCssUpdate();
    if (state.docs.has(change.path)) scheduleExternalUpdate(change.path);
    // 内容写入不改变目录；重命名、增删及无路径事件仍重新扫描。
    if (change.event === "change" && change.path) return;
    clearTimeout(treeRefreshTimer);
    treeRefreshTimer = setTimeout(refreshTree, 80);
  };
}
async function checkCssUpdate() {
  try {
    const text = await api("/mewde.css", { cache: "no-store" });
    const changed = text !== state.cssText;
    state.cssText = text;
    if (changed) refreshPreview();
  } catch {}
}
function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}
function closeMenus(except) {
  document.querySelectorAll(".menu[open]").forEach(menu => {
    if (menu !== except) menu.open = false;
  });
}

buildTagBar(); setupTagPanel(); renderTabs(); refreshTree(); connectFileEvents(); checkCssUpdate();
let composing = false;
$("editor").addEventListener("compositionstart", () => { remember(); composing = true; });
$("editor").addEventListener("compositionend", () => { composing = false; commitEditorChange(); });
$("editor").addEventListener("beforeinput", e => {
  if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
    e.preventDefault(); (e.inputType === "historyUndo" ? undo : redo)();
  } else if (!composing) {
    const d = doc(), ed = $("editor"), group = d?.inputGroup, now = Date.now();
    const typing = e.inputType === "insertText" && ed.selectionStart === ed.selectionEnd;
    if (!typing || !group || now - group.time > 700 || group.end !== ed.selectionStart) remember();
    if (d) d.inputGroup = typing ? { time: now, end: ed.selectionStart + (e.data || "").length } : null;
  }
});
$("editor").addEventListener("input", commitEditorChange);
$("editor").addEventListener("scroll", syncHighlightScroll);
$("editor").addEventListener("click", openEditorLink);
document.addEventListener("keydown", keydown);
$("saveBtn").onclick = save; $("saveAllBtn").onclick = saveAll; $("undoBtn").onclick = undo; $("redoBtn").onclick = redo;
$("prevFileBtn").onclick = () => openSiblingFile(-1); $("nextFileBtn").onclick = () => openSiblingFile(1);
$("newWinBtn").onclick = openFileWindow; $("closeSavedBtn").onclick = () => closeAll(true); $("closeAllBtn").onclick = () => closeAll(false);
$("darkBtn").onclick = () => { setDark(!document.body.classList.contains("dark")); refreshPreview(); };
$("fullBtn").onclick = toggleFull;
$("refreshBtn").onclick = refreshPreview; $("openRawBtn").onclick = openRaw;
$("findBtn").onclick = $("nextBtn").onclick = gotoMatch; $("replaceBtn").onclick = replaceOne; $("allBtn").onclick = replaceAll;
$("findText").oninput = findAll; $("regexBox").onchange = findAll; $("caseBox").onchange = findAll; $("treeFilter").oninput = filterTree;
$("fileMenu").addEventListener("click", e => {
  if (e.target.closest(".menuPanel button")) $("fileMenu").open = false;
});
document.addEventListener("pointerdown", e => {
  closeMenus(e.target.closest(".menu"));
});
$("tabs").onclick = e => {
  const close = e.target.closest("[data-close]");
  if (close) { e.stopPropagation(); return closeDocs([close.dataset.close]); }
  const tab = e.target.closest(".tab[data-path]");
  if (tab) switchDoc(tab.dataset.path);
};
$("tabs").onauxclick = e => {
  const tab = e.target.closest(".tab[data-path]");
  if (e.button === 1 && tab) { e.preventDefault(); closeDocs([tab.dataset.path]); }
};
$("tree").onclick = e => {
  const row = e.target.closest(".item");
  if (row) row.dataset.type === "dir" ? toggleDir(row, row.dataset.path) : openFile(row.dataset.path);
};
$("tree").onkeydown = treeKeydown;
$("treeRefreshBtn").onclick = refreshTree;
$("treeRevealBtn").onclick = revealFile;
$("treeCollapseBtn").onclick = () => {
  $("tree").querySelectorAll(".indent").forEach(box => box.remove());
  $("tree").querySelectorAll("[aria-expanded]").forEach(row => { row.setAttribute("aria-expanded", "false"); row.firstChild.textContent = "+"; });
};
setDark(localStorage.getItem("mewDark") === "1");
const startFile = new URLSearchParams(location.search).get("file");
if (startFile) openFile(startFile);
updateHighlight();
window.addEventListener("beforeunload", e => {
  persistEditor();
  if ([...state.docs.values()].some(d => d.dirty)) { e.preventDefault(); e.returnValue = ""; }
});
