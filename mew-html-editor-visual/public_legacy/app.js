const $ = id => document.getElementById(id);
const state = { path: "", docs: new Map(), checkingTree: false, cssText: "", treeText: "" };
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
const tagMap = new Map(tags.filter(tag => tag.shortcut).map(tag => [tag.shortcut.toLowerCase(), tag]));
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

class DocumentModel {
  static async load(options) {
    return new DocumentModel({ ...options, ...await options.read() });
  }

  constructor({ text = "", mtime = null, editable = true, read, write } = {}) {
    this.content = text;
    this.savedContent = text;
    this.mtime = mtime;
    this.editable = editable;
    this.revision = 0;
    this.reloadRevision = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.read = read;
    this.write = write;
    this.pending = Promise.resolve();
  }

  get dirty() { return this.content !== this.savedContent; }

  textFromEditor(text) {
    // Textareas normalize CRLF and CR to LF. Keep the original bytes when
    // the editor still represents the current or saved source.
    const normalize = value => value.replace(/\r\n?/g, "\n");
    for (const source of [this.content, this.savedContent]) {
      if (normalize(source) === normalize(text)) return source;
    }
    return text;
  }

  update(text) {
    if (text !== this.content) this.revision += 1;
    this.content = text;
  }

  pushHistory(stack, snapshot) {
    stack.push(snapshot);
    let size = stack.reduce((sum, item) => sum + item.text.length, 0);
    while (stack.length > 100 || size > 10_000_000) size -= stack.shift().text.length;
  }

  remember(snapshot) {
    const last = this.undoStack.at(-1);
    if (!last || ["text", "start", "end"].some(key => last[key] !== snapshot[key])) {
      this.pushHistory(this.undoStack, snapshot);
    }
    this.redoStack = [];
  }

  restore(from, to, current) {
    const snapshot = from.pop();
    if (!snapshot) return null;
    this.pushHistory(to, current);
    this.update(snapshot.text);
    return snapshot;
  }

  undo(current) { return this.restore(this.undoStack, this.redoStack, current); }
  redo(current) { return this.restore(this.redoStack, this.undoStack, current); }

  enqueue(operation) {
    const task = this.pending.then(operation);
    this.pending = task.catch(() => {});
    return task;
  }

  async writeSnapshot(text) {
    if (!this.editable) throw new Error("Document is read-only");
    const result = await this.write({ text, mtime: this.mtime });
    this.savedContent = text;
    this.mtime = result.mtime;
    return result;
  }

  save(text = this.content) {
    const revision = this.reloadRevision;
    return this.enqueue(() => {
      if (revision !== this.reloadRevision) throw new Error("File reloaded before saving. Review the current content and save again.");
      return this.writeSnapshot(text);
    });
  }

  async saveUntilClean() {
    while (this.dirty) {
      await this.enqueue(() => this.dirty ? this.writeSnapshot(this.content) : undefined);
    }
  }

  refresh() {
    return this.enqueue(async () => {
      const data = await this.read();
      const result = data.text === this.savedContent ? "unchanged"
        : data.text === this.content ? "saved" : "updated";
      if (result === "updated") {
        if (this.dirty) return "conflict";
        this.reloadRevision += 1;
        this.update(data.text);
        this.undoStack = [];
        this.redoStack = [];
      }
      this.savedContent = data.text;
      this.mtime = data.mtime;
      return result;
    });
  }
}
const PREVIEW_DELAY = 200;
const TAG_PANEL_KEY = "mewTagPanel.v1";
let highlightFrame = 0;
let previewTimer = 0;
function api(url, options) {
  if (window.MEWBackend) return window.MEWBackend.api(url, options);
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
  return { text: doc()?.textFromEditor(ed.value) ?? ed.value, start: ed.selectionStart, end: ed.selectionEnd };
}
function restoreEditorSnapshot(snap, ed = $("editor")) {
  ed.value = snap.text;
  ed.focus();
  ed.setSelectionRange(snap.start, snap.end);
}
function themeColors() {
  const style = getComputedStyle(document.body);
  return {
    bg: style.getPropertyValue("--bg").trim(),
    ink: style.getPropertyValue("--ink").trim()
  };
}
function persistEditor() {
  const d = doc();
  if (!d) return;
  const ed = $("editor");
  d.update(d.textFromEditor(ed.value)); d.selA = ed.selectionStart; d.selB = ed.selectionEnd;
}
function markDirty(forceTabs = false) {
  const d = doc();
  const tagTitle = $("tagPanelTitle");
  if (!d) {
    $("fileName").textContent = "No file open";
    tagTitle.textContent = "标签";
    tagTitle.title = "";
    $("tagPrevFileBtn").disabled = true;
    $("tagNextFileBtn").disabled = true;
    renderTabs();
    return;
  }
  const wasDirty = d.dirty;
  d.update(d.textFromEditor($("editor").value));
  $("fileName").textContent = d.path + (d.dirty ? " *" : "");
  tagTitle.textContent = `标签 · ${fileLabel(d.path)}`;
  tagTitle.title = d.path;
  $("tagPrevFileBtn").disabled = false;
  $("tagNextFileBtn").disabled = false;
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
function renderTabs() {
  const tabs = $("tabs");
  tabs.innerHTML = [...state.docs.values()].map(d => `
    <button class="tab${d.path === state.path ? " active" : ""}" data-path="${esc(d.path)}" title="${esc(d.path)}">
      <span class="tabName">${esc(fileLabel(d.path))}${d.dirty ? " *" : ""}</span>
      <span class="tabClose" data-close="${esc(d.path)}" title="Close">x</span>
    </button>
  `).join("");
  tabs.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function remember() {
  doc()?.remember(editorSnapshot());
}
function restoreHistory(method, message) {
  const snapshot = doc()?.[method](editorSnapshot());
  if (!snapshot) return note(`Nothing to ${method}`);
  restoreEditorSnapshot(snapshot);
  markDirty(true); scheduleEditorRefresh(); note(message);
}
function undo() { restoreHistory("undo", "Undone"); }
function redo() { restoreHistory("redo", "Redone"); }

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
    row.onclick = ev => {
      ev.stopPropagation();
      if (e.type === "dir") return toggleDir(row, e.path);
      openFile(e.path);
    };
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
  const next = row.nextElementSibling;
  if (next?.classList.contains("indent")) { next.remove(); row.firstChild.textContent = "+"; return; }
  row.firstChild.textContent = "-";
  await loadTree(rel, row);
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
    const nextText = nextTree.textContent;
    if (state.treeText !== nextText) {
      $("tree").replaceChildren(...nextTree.childNodes);
      if (state.treeText) note("File tree updated");
      filterTree();
    }
    state.treeText = nextText;
  } catch (e) {
    note(e.message);
  } finally {
    state.checkingTree = false;
  }
}
async function openFile(rel) {
  if (state.docs.has(rel)) return switchDoc(rel);
  try {
    const d = await DocumentModel.load({
      read: async () => {
        const data = await api(`/api/file?path=${encodeURIComponent(rel)}`);
        rel = data.path;
        return data;
      },
      write: snapshot => postJson("/api/save", { path: rel, ...snapshot })
    });
    // A second open may have completed while this request was in flight.
    if (!state.docs.has(rel)) state.docs.set(rel, Object.assign(d, {
      path: rel, matches: [], match: -1, selA: 0, selB: 0
    }));
    switchDoc(rel);
  } catch (error) { note(error.message); }
}
async function openSiblingFile(direction) {
  if (!state.path) return note("Open a file first");
  persistEditor();
  const current = doc();
  if (current?.dirty) {
    try {
      await current.saveUntilClean();
      markDirty();
    } catch (error) {
      note(`自动保存失败：${error.message}`);
      return;
    }
  }
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
  persistEditor();
  const d = state.docs.get(path);
  if (path && !d) return;
  state.path = path;
  $("editor").value = d?.content || "";
  setActiveTreePath(path);
  markDirty(true); refreshDocumentView(); $("editor").focus();
  $("editor").setSelectionRange(d?.selA || 0, d?.selB || 0);
}
function closeDocs(paths) {
  let next = state.path;
  for (const path of paths) {
    const d = state.docs.get(path);
    if (!d || (d.dirty && !confirm(`${d.path} has unsaved changes. Close it?`))) continue;
    if (next === path) {
      const keys = [...state.docs.keys()], i = keys.indexOf(path);
      next = keys[i + 1] || keys[i - 1] || "";
    }
    state.docs.delete(path);
  }
  if (next !== state.path) {
    state.path = "";
    switchDoc(next);
  } else {
    renderTabs();
  }
}
function closeAll(savedOnly = false) {
  closeDocs([...state.docs.values()].filter(d => !savedOnly || !d.dirty).map(d => d.path));
  note(savedOnly ? "Closed saved windows" : state.docs.size ? "Some windows remain open" : "Closed all windows");
}
function openFileWindow() {
  if (!state.path) return note("Open a file first");
  window.open(`/?file=${encodeURIComponent(state.path)}`, "_blank");
}
async function save(all = false) {
  all = all === true;
  persistEditor();
  const documents = all ? [...state.docs.values()] : [doc()];
  if (!all && !documents[0]) return note("Open a file first");
  let savedPath;
  for (const d of documents) {
    // A document may have become clean while a preceding save was in flight.
    if (all && !d.dirty) continue;
    try {
      savedPath = (await d.save()).path;
    } catch (e) {
      if (all) switchDoc(d.path);
      note(e.message);
      return;
    }
  }
  markDirty(true);
  const dirty = (all ? [...state.docs.values()] : documents).some(d => d.dirty);
  note(all ? dirty ? "Saved snapshots; newer edits remain unsaved" : "Saved all"
    : `Saved ${savedPath}${dirty ? "; newer edits remain unsaved" : ""}`);
}
function saveAll() { return save(true); }
function refreshPreview() {
  clearTimeout(previewTimer);
  const preview = $("preview");
  preview.hidden = !state.path;
  if (!state.path) {
    // Do not navigate an already-empty iframe: a startup empty navigation can
    // swallow the srcdoc navigation made moments later when a file opens.
    if (preview.srcdoc) preview.srcdoc = "";
    return;
  }
  const dir = state.path.split("/").slice(0, -1).join("/");
  const { bg, ink } = themeColors();
  const css = `${state.cssText ? `<style>${state.cssText}</style>` : '<link rel="stylesheet" href="/mewde.css">'}<style>body{background:${bg};color:${ink}}</style>`;
  const baseUrl = window.MEWBackend?.rawUrl(dir, true) || `/raw/${encodeURI(dir)}${dir ? "/" : ""}`;
  const base = `<base href="${baseUrl}">`;
  preview.srcdoc = base + css + $("editor").value;
}
function openRaw() {
  if (state.path) {
    const { bg, ink } = themeColors();
    if (window.MEWBackend) return window.MEWBackend.openRaw(state.path, $("editor").value, state.cssText, { bg, ink });
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
  const name = /^<([A-Za-z][\w:-]*)\b/.exec(tag.open)?.[1].toLowerCase();
  const simple = name && tag.close.toLowerCase() === `</${name}>`;
  const complete = start < end && isCompleteSelection(text, elements, start, end);
  const exact = complete && elements.find(element => element.start === start && element.end === end);

  if (complete) {
    // 错配闭合标签：以前面的开始标签为准。点击同类标签删除，
    // 点击其他标签则直接替换整个外层，而不是再包一层。
    if (exact && exact.closeName && exact.closeName !== exact.name) {
      if (name === exact.name) return changeWrapper(text, exact, start, end);
      return changeWrapper(text, exact, start, end, tag);
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
  // Each opening token has one pair: index it once instead of rescanning per sibling.
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
      if (open?.name !== name) {
        const crossed = stack.findLastIndex(item => item.name === name);
        // 交叉标签截断栈；没有同名开始标签时，按最近的开始标签容错配对。
        if (crossed >= 0) { stack.length = crossed; continue; }
      }
      if (open) {
        stack.pop();
        pairs.push({ name: open.name, closeName: name, start: open.start, openEnd: open.end, closeStart: match.index, end: tagPattern.lastIndex, open: open.token });
        if (name === rawName) rawName = undefined;
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
    '<span class="spacer"></span>',
    ...attrs.map((attr, i) => `<button class="tag attrTag" data-attr="${i}" title="${esc(attr.title)}">${esc(attr.label)}</button>`),
    '<span class="spacer"></span>',
    '<button id="tagPrevFileBtn" class="tag attrTag tagFileNav" data-nav="-1" title="上一文件；切换前自动保存">←</button>',
    '<button id="tagNextFileBtn" class="tag attrTag tagFileNav" data-nav="1" title="下一文件；切换前自动保存">→</button>'
  ].join("");
  $("tagBar").onclick = e => {
    const button = e.target.closest("button");
    if (!button) return;
    const { i, attr, nav } = button.dataset;
    if (i != null) editTag(tags[Number(i)]);
    else if (attr != null) insertAttr(attrs[Number(attr)]);
    else if (nav != null) openSiblingFile(Number(nav));
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
    row.style.display = row.textContent.toLowerCase().includes(q) ? "" : "none";
  });
}
function keydown(e) {
  if (e.defaultPrevented) return;
  const inEditor = document.activeElement === $("editor");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
  if (inEditor && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
  if (inEditor && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (inEditor && (e.altKey || $("instant").checked) && !e.ctrlKey && !e.metaKey) {
    const k = e.key.toLowerCase();
    const tag = tagMap.get(k);
    if (tag) { e.preventDefault(); editTag(tag); }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); $("findText").focus(); }
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
  return raw.replace(/(<\/?)([A-Za-z][\w:-]*)|([\w:-]+)(\s*=\s*)("[^"]*"|'[^']*')|([<>/=])|[&"']/g,
    (token, opening, name, attr, equals, value, punctuation) => {
      if (opening) return `<span class="tok-punct">${esc(opening)}</span><span class="tok-tag">${esc(name)}</span>`;
      if (attr) return `<span class="tok-attr">${esc(attr)}</span><span class="tok-punct">${esc(equals)}</span>${attrToken(token, value)}`;
      return punctuation ? `<span class="tok-punct">${esc(punctuation)}</span>` : esc(token);
    });
}
function highlightHtml(text) {
  return text.replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*?>|[&<>"']/g,
    token => token.length === 1 ? esc(token) : colorTag(token))
    + (text.endsWith("\n") ? " " : "");
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
  const base = state.path ? (window.MEWBackend?.rawUrl(dir, true) || `${location.origin}/raw/${encodeURI(dir)}${dir ? "/" : ""}`) : location.href;
  window.open(new URL(href, base).href, "_blank");
}
function trimSourceWordSelection() {
  const ed = $("editor");
  let start = ed.selectionStart, end = ed.selectionEnd;
  if (start === end) return;
  while (start < end && /\s/.test(ed.value[start])) start += 1;
  while (end > start && /\s/.test(ed.value[end - 1])) end -= 1;
  ed.setSelectionRange(start, end);
}
function applyExternalUpdate(d) {
  if (d.path !== state.path) return renderTabs();
  const ed = $("editor");
  const a = Math.min(ed.selectionStart, d.content.length), b = Math.min(ed.selectionEnd, d.content.length);
  ed.value = d.content;
  ed.setSelectionRange(a, b);
  markDirty(true); refreshDocumentView();
  note(`Updated ${d.path}`);
}
const externalCheckTimers = new Map();
let treeRefreshTimer = 0;
async function checkExternalUpdate(path) {
  const d = state.docs.get(path);
  if (!d) return;
  try {
    if (d.path === state.path) persistEditor();
    const result = await d.refresh();
    if (state.docs.get(path) !== d) return;
    if (result === "conflict") note(`External update pending for ${d.path}; close and reopen to reload`);
    else if (result === "updated") applyExternalUpdate(d);
    else if (result === "saved") {
      if (d.path === state.path) markDirty(true);
      else renderTabs();
    }
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
  const handleChange = change => {
    if (change.event === "ready") return;
    if (change.path === "mewde.css") checkCssUpdate();
    if (state.docs.has(change.path)) scheduleExternalUpdate(change.path);
    if (change.event === "change" && change.path) return;
    clearTimeout(treeRefreshTimer);
    treeRefreshTimer = setTimeout(refreshTree, 80);
  };
  if (window.MEWBackend) return window.MEWBackend.connectEvents(handleChange);
  const events = new EventSource("/api/events");
  events.onmessage = event => {
    let change;
    try { change = JSON.parse(event.data); } catch { return; }
    handleChange(change);
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

buildTagBar(); setupTagPanel(); markDirty(); refreshTree(); connectFileEvents(); checkCssUpdate();
$("editor").addEventListener("beforeinput", remember);
$("editor").addEventListener("input", commitEditorChange);
$("editor").addEventListener("scroll", syncHighlightScroll);
$("editor").addEventListener("dblclick", trimSourceWordSelection);
$("editor").addEventListener("click", openEditorLink);
document.addEventListener("keydown", keydown);
$("saveBtn").onclick = save; $("saveAllBtn").onclick = saveAll; $("undoBtn").onclick = undo; $("redoBtn").onclick = redo;
if (window.MEWBackend) {
  $("submitChangeBtn").hidden = false;
  $("submitChangeBtn").onclick = () => window.MEWBackend.submitChanges().catch(error => note(error.message));
  $("gitConfigBtn").hidden = false;
  $("gitConfigBtn").onclick = () => { location.href = "../git-editor.html"; };
}
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
setDark(localStorage.getItem("mewDark") === "1");
const startFile = new URLSearchParams(location.search).get("file");
if (startFile) openFile(startFile);
updateHighlight();
window.addEventListener("beforeunload", e => {
  persistEditor();
  if ([...state.docs.values()].some(d => d.dirty)) { e.preventDefault(); e.returnValue = ""; }
});
