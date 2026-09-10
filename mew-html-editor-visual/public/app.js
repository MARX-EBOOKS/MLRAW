// index.html application: documents, persistence, Monaco models and commands.
let editor, monaco, source, previewTimer = 0, openRevision = 0, closing = false;
const PREVIEW_DELAY = 200, TAG_PANEL_KEY = 'mewMonacoTagPanel.v1';
const ui = window.MewEditorUI;
if (!ui) throw new Error('MewEditorUI 未载入');
const { $, note } = ui;
const state = { path: "", docs: new Map(), cssText: "" };
const core = window.MewEditorCore;
if (!core) throw new Error('MewEditorCore 未载入');
const tagPanel = window.MewTagPanel;
if (!tagPanel) throw new Error('MewTagPanel 未载入');
const { DocumentModel, MonacoController, createChannel, languageForPath } = core;
const { tags, attrs, tagMap } = tagPanel;
let workbenchChordTimer = 0, workbenchChordPending = false;

function handleWorkbenchChord(event) {
  if (event.isComposing) return;
  const key = event.key.toLowerCase();
  if (workbenchChordPending) {
    if (['control', 'meta', 'shift', 'alt'].includes(key)) return;
    clearTimeout(workbenchChordTimer);
    workbenchChordPending = false;
    const action = !event.altKey && !event.shiftKey && { s: saveAll, u: () => closeAll(true), w: () => closeAll(false) }[key];
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    action();
    return;
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || key !== 'k') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  workbenchChordPending = true;
  clearTimeout(workbenchChordTimer);
  workbenchChordTimer = setTimeout(() => { workbenchChordPending = false; }, 2000);
}
const readerSession = (() => {
  const value = new URLSearchParams(location.search).get('readerSession') || '';
  return /^[\w-]{1,128}$/.test(value) ? value : '';
})();
let readerChannel = null;

function announceEditorPage() {
  if (!readerChannel || !state.path) return;
  readerChannel.postMessage({ source: 'editor', type: 'editor-page', path: state.path, dirty: Boolean(doc()?.dirty) });
}

function startReaderSync() {
  if (!readerSession) return;
  readerChannel = createChannel(readerSession, message => {
    if (!message || message.source !== 'reader') return;
    if (message.type === 'reader-page' && message.path) {
      if (message.path === state.path) return announceEditorPage();
      openFile(message.path);
    } else if (message.type === 'reader-ready') announceEditorPage();
    else if (message.type === 'reader-detached') {
      readerChannel?.close();
      readerChannel = null;
      note('阅读器已恢复合窗；本编辑器继续独立运行');
    }
  });
  readerChannel.postMessage({ source: 'editor', type: 'editor-ready' });
  ui.setReaderLinkedTitle();
}
function api(url, options) {
  if (window.MEWBackend) return window.MEWBackend.api(url, options);
  return fetch(url, options).then(async r => {
    const type = r.headers.get("content-type") || "";
    const data = type.includes("json") ? await r.json() : await r.text();
    if (!r.ok || data.error) {
      const error = new Error(data.error || data);
      error.status = r.status;
      if (data && typeof data === 'object') Object.assign(error, data);
      throw error;
    }
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
function doc() { return state.docs.get(state.path); }
function currentDirectory() { return state.path.split('/').slice(0, -1).join('/'); }
function joinCurrentDirectory(name) { return [currentDirectory(), name].filter(Boolean).join('/'); }
async function createFileAt(path, text) {
  try {
    return await postJson('/api/create', { path, text });
  } catch (error) {
    if (error.code !== 'FILE_EXISTS' || !confirm(`${path} 已存在。是否覆盖？`)) throw error;
    return postJson('/api/create', { path, text, overwrite: true, mtime: error.mtime });
  }
}
async function newFile() {
  const directory = currentDirectory();
  const name = await ui.askFileName({ mode: 'new', directory });
  if (!name) return;
  const path = joinCurrentDirectory(name);
  if (state.docs.has(path)) return note(`${path} 已经打开`);
  try {
    await createFileAt(path, '');
    await openFile(path);
    ui.tree.scheduleRefresh();
    note(`Created ${path}`);
  } catch (error) { note(error.message); }
}
async function saveAs() {
  const d = doc();
  if (!d) return note('Open a file first');
  const directory = currentDirectory();
  const name = await ui.askFileName({ mode: 'saveAs', directory, initialName: d.path.split('/').pop() });
  if (!name) return;
  const target = joinCurrentDirectory(name);
  if (target === d.path) return save();
  if (state.docs.has(target)) return note(`${target} 已经打开`);
  const snapshot = d.content;
  try {
    const data = await d.enqueue(() => createFileAt(target, snapshot));
    const oldPath = d.path;
    const viewState = editor.saveViewState();
    state.docs.delete(oldPath);
    externalCheckTimers.delete(oldPath);
    d.reloadRevision += 1;
    d.path = data.path;
    d.savedContent = snapshot;
    d.mtime = data.mtime;
    d.read = () => api(`/api/file?path=${encodeURIComponent(d.path)}`);
    d.write = value => postJson('/api/save', { path: d.path, ...value });
    d.model?.dispose();
    d.model = null;
    d.viewState = viewState;
    state.docs.set(d.path, d);
    state.path = d.path;
    switchDoc(d.path);
    ui.tree.scheduleRefresh();
    note(`Saved as ${d.path}${d.dirty ? '; newer edits remain unsaved' : ''}`);
  } catch (error) { note(error.message); }
}
async function openFile(rel) {
  const request = ++openRevision;
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
      path: rel
    }));
    if (request === openRevision) switchDoc(rel);
  } catch (error) { note(error.message); }
}
async function openSiblingFile(direction) {
  if (!state.path) return note("Open a file first");
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

function openFileWindow() {
  if (!state.path) return note("Open a file first");
  const url = new URL(location.href);
  url.searchParams.set("file", state.path);
  url.searchParams.delete("readerSession");
  window.open(url, "_blank");
}
async function save() {
  const d = doc();
  if (!d) return note("Open a file first");
  const savedText = d.content;
  try {
    const data = await d.save(savedText);
    if (d.path === state.path) markDirty(true);
    else renderTabs();
    note(`Saved ${data.path}${d.dirty ? "; newer edits remain unsaved" : ""}`);
  } catch (e) {
    note(e.message);
  }
}
async function saveAll() {
  for (const d of [...state.docs.values()]) {
    if (!d.dirty) continue;
    const savedText = d.content;
    try {
      await d.save(savedText);
    } catch (e) {
      switchDoc(d.path); note(e.message); return;
    }
  }
  markDirty(true);
  note([...state.docs.values()].some(d => d.dirty) ? "Saved snapshots; newer edits remain unsaved" : "Saved all");
}
function refreshPreview() {
  clearTimeout(previewTimer);
  if (!state.path) return;
  ui.renderPreview({
    path: state.path,
    cssText: state.cssText,
    html: editor.getValue(),
    rawUrl: window.MEWBackend ? (dir, absolute) => window.MEWBackend.rawUrl(dir, absolute) : null
  });
}
function openRaw() {
  if (state.path) {
    const { bg, ink } = ui.themeColors();
    if (window.MEWBackend) return window.MEWBackend.openRaw(state.path, editor.getValue(), state.cssText, { bg, ink });
    window.open(`/raw/${encodeURI(state.path)}?bg=${encodeURIComponent(bg)}&fg=${encodeURIComponent(ink)}`, "_blank");
  }
}
const externalCheckTimers = new Map();
async function checkExternalUpdate(path) {
  const d = state.docs.get(path);
  if (!d) return;
  try {
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
    ui.tree.scheduleRefresh();
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
// Each opened file owns one Monaco model and view state. All commands address
// this same document registry; ui.js owns its visual representation.
function modelFor(d) {
  if (!d.model) {
    d.model = source.createModel({
      text: d.content,
      language: languageForPath(monaco, d.path),
      uri: monaco.Uri.from({ scheme: 'mew', path: '/' + d.path }),
      onChange: model => {
        d.update(d.textFromEditor(model.getValue()));
        if (d === doc()) { markDirty(true); scheduleEditorRefresh(); }
        else renderTabs();
      }
    });
  }
  return d.model;
}
function saveEditorView() {
  const d = doc();
  if (!d || editor.getModel() !== d.model) return;
  d.viewState = editor.saveViewState();
}
function markDirty() {
  const d = doc();
  ui.renderDocumentState(d, state.docs.values());
  announceEditorPage();
}
function renderTabs() {
  ui.renderTabs(state.docs.values(), doc());
}
function switchDoc(path) {
  saveEditorView();
  const d = state.docs.get(path);
  if (!d) return;
  state.path = path;
  editor.setModel(modelFor(d));
  const language = d.model.getLanguageId();
  editor.updateOptions({
    readOnly: !d.editable,
    colorDecorators: ["html", "css", "scss", "less"].includes(language),
    defaultColorDecorators: language === "html" ? "never" : "auto"
  });
  ui.setLanguage(`${ui.languageLabel(monaco, language)} · UTF-8`);
  if (d.viewState) editor.restoreViewState(d.viewState);
  ui.tree.setActive(path); markDirty(); refreshPreview(); editor.focus();
}
function scheduleEditorRefresh() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, PREVIEW_DELAY);
}
function applyExternalUpdate(d) {
  // Also update inactive models; otherwise switching tabs could restore stale text.
  if (d.model && d.model.getValue() !== d.content) {
    const view = d === doc() ? editor.saveViewState() : null;
    d.model.setValue(d.content);
    if (view) editor.restoreViewState(view);
  }
  markDirty();
  if (d === doc()) refreshPreview();
  note(`Updated ${d.path}`);
}
function editTag(tag) {
  if (!doc()) return note('Open a file first');
  if (doc().editable) tagPanel.applyTag(source, tag);
}
function insertAttr(attr) {
  if (!doc()) return note('Open a file first');
  if (doc().editable) tagPanel.insert(source, attr);
}
function undo() { source.undo(); }
function redo() { source.redo(); }
function toggleFindReplace() { return source?.toggleFind(); }
async function closeDocs(paths) {
  if (closing) return;
  closing = true;
  ++openRevision;
  try {
    for (const path of paths) {
      const d = state.docs.get(path);
      if (!d) continue;
      if (d.dirty) {
        const choice = await ui.askClose(d);
        if (choice === 'cancel' || !choice) break;
        if (choice === 'save') {
          try { await d.saveUntilClean(); }
          catch (error) { note(error.message); break; }
        }
      }
      if (state.docs.get(path) !== d) continue;
      if (doc() === d) { editor.setModel(null); state.path = ''; }
      state.docs.delete(path);
      d.model?.dispose();
    }
    if (!doc()) {
      const next = state.docs.keys().next().value;
      if (next) switchDoc(next);
      else {
        editor.setModel(null);
        ui.clearPreview();
        ui.tree.setActive();
      }
    }
    markDirty();
  } finally { closing = false; }
}
function closeAll(savedOnly = false) {
  return closeDocs([...state.docs.values()].filter(d => !savedOnly || !d.dirty).map(d => d.path));
}
function initialize(api) {
  monaco = api;
  const scale = ui.editorScale();
  source = new MonacoController(monaco, $('monacoEditor'), {
    model: null, automaticLayout: true, fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: 14 * scale, lineHeight: Math.round(21 * scale), tabSize: 2, wordWrap: 'on', minimap: { enabled: false },
    find: { addExtraSpaceOnTop: false },
    // 0.55.1 occurrence requests can reject on rapid model switches.
    occurrencesHighlight: 'off', scrollBeyondLastLine: false, padding: { top: 14, bottom: 14 }
  });
  editor = source.editor;
  editor.onDidChangeCursorPosition(event => {
    ui.setPosition(event.position.lineNumber, event.position.column);
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, saveAs);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN, newFile);
  // Capture only tag shortcuts. Monaco handles typing, IME, undo and find itself.
  $('monacoEditor').addEventListener('keydown', event => {
    if (event.isComposing || event.ctrlKey || event.metaKey || !editor.hasTextFocus()) return;
    if (!event.altKey && !$('instant').checked) return;
    const tag = tagMap.get(event.key.toLowerCase());
    const br = event.altKey && event.key === 'Enter';
    if (tag || br) {
      event.preventDefault(); event.stopPropagation();
      if (tag) editTag(tag); else insertAttr(attrs.find(attr => attr.id === 'BR'));
    }
  }, true);
  document.addEventListener('keydown', handleWorkbenchChord, true);
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 's') { event.preventDefault(); if (event.shiftKey) saveAs(); else save(); }
    else if (key === 'n' && !event.shiftKey) { event.preventDefault(); newFile(); }
  });
  ui.mountTagPanel({
    tags, attrs, storageKey: TAG_PANEL_KEY,
    onTag: editTag,
    onAttr: insertAttr,
    onNavigate: openSiblingFile,
    onEditorScale: value => source?.setScale(value)
  });
  ui.bindWorkbench({
    newFile, save, saveAs, saveAll, undo, redo, find: toggleFindReplace,
    navigate: openSiblingFile,
    openWindow: openFileWindow,
    closeAll,
    toggleDark: () => ui.setDark(monaco, !ui.isDark(), refreshPreview),
    refreshPreview,
    openRaw,
    activePath: () => state.path,
    closeDocuments: closeDocs,
    activateDocument(path) { ++openRevision; switchDoc(path); }
  });
  ui.setDark(monaco, localStorage.getItem('mewDark') === '1', refreshPreview);
  startReaderSync();
  connectFileEvents(); checkCssUpdate();
  const file = new URLSearchParams(location.search).get('file');
  if (file) openFile(file);
  window.addEventListener('beforeunload', event => {
    readerChannel?.postMessage({ source: 'editor', type: 'editor-closed', path: state.path });
    if ([...state.docs.values()].some(d => d.dirty)) { event.preventDefault(); event.returnValue = ''; }
  });
  window.mewWorkbench = { editor, documents: state.docs, openFile, newFile, saveAs };
}
// The explorer does not depend on Monaco. Load it immediately so an editor
// loader failure or delay cannot leave the file tree blank.
ui.tree.configure({
  read: rel => api(`/api/tree?path=${encodeURIComponent(rel)}`),
  open: rel => editor ? openFile(rel) : note('编辑器仍在加载'),
  activePath: () => state.path
});
ui.tree.refresh();
core.loadMonaco().then(initialize, error => {
  ui.showMonacoError(error);
});
