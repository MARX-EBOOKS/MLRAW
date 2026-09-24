// index.html application: documents, persistence, Monaco models and commands.
let editor, monaco, source, previewTimer = 0, openRevision = 0, closing = false;
const PREVIEW_DELAY = 200, TAG_PANEL_KEY = 'mewMonacoTagPanel.v1';
const ui = window.MewEditorUI;
if (!ui) throw new Error('MewEditorUI 未载入');
const { byId, notify } = ui;
const state = { path: "", docs: new Map(), cssText: "" };
const pendingOpens = new Map();
let loadEpoch = 0;
let sessionKey = '', backupTimer = 0, backupWarning = false;
let sessionReady = Promise.resolve();
let restoringSession = true;

function persistSession() {
  clearTimeout(backupTimer);
  if (restoringSession || !sessionKey || !editor) return;
  saveEditorView();
  try {
    sessionStorage.setItem(sessionKey, JSON.stringify({
      version: 1, active: state.path,
      documents: [...state.docs.values()].map(d => ({
        path: d.path, viewState: d.viewState,
        ...(d.dirty ? { content: d.content, savedContent: d.savedContent, mtime: d.mtime } : {})
      }))
    }));
    backupWarning = false;
  } catch {
    if (!backupWarning) notify('页面暂存失败；请先保存文件，刷新可能丢失未保存的修改');
    backupWarning = true;
  }
}
function scheduleSessionBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(persistSession, 200);
}
async function restoreSession() {
  try {
    const workspace = await api('/api/tree');
    const config = window.MEWBackend?.config;
    sessionKey = 'mew.editor.session.v1:' + JSON.stringify([location.pathname, workspace.root,
      config ? [config.provider, config.apiUrl, config.repository, config.branch, config.root] : null, syncSession]);
    const saved = JSON.parse(sessionStorage.getItem(sessionKey) || 'null');
    if (saved?.version !== 1 || !Array.isArray(saved.documents)) return;
    for (const entry of saved.documents) {
      if (typeof entry.path !== 'string' || !entry.path || state.docs.has(entry.path)) continue;
      const options = {
        read: () => api(`/api/file?path=${encodeURIComponent(entry.path)}`),
        write: snapshot => postJson('/api/save', { path: entry.path, ...snapshot })
      };
      const hasDraft = typeof entry.content === 'string' && typeof entry.savedContent === 'string';
      let d;
      try { d = await DocumentModel.load(options); }
      catch (error) {
        if (!hasDraft) { notify(`无法恢复 ${entry.path}: ${error.message}`); continue; }
        d = new DocumentModel({ ...options, text: entry.savedContent, mtime: entry.mtime });
        notify(`已恢复 ${entry.path} 的暂存内容，但无法读取磁盘文件：${error.message}`);
      }
      if (hasDraft && d.content !== entry.content) {
        if (d.savedContent !== entry.savedContent) {
          // Keep the original disk version so saving still detects the conflict.
          d.savedContent = entry.savedContent;
          d.mtime = entry.mtime;
          notify(`${entry.path} 在暂存后已被外部修改；已保留暂存内容，保存时将检查冲突`);
        }
        d.update(entry.content);
      }
      Object.assign(d, { path: entry.path, viewState: entry.viewState });
      state.docs.set(d.path, d);
    }
    const active = state.docs.has(saved.active) ? saved.active : state.docs.keys().next().value;
    if (active) switchDoc(active);
  } catch (error) {
    sessionKey = '';
    notify(`页面暂存不可用：${error.message}`);
  } finally {
    restoringSession = false;
  }
}
const core = window.MewEditorCore;
if (!core) throw new Error('MewEditorCore 未载入');
const tagPanel = window.MewTagPanel;
if (!tagPanel) throw new Error('MewTagPanel 未载入');
const { DocumentModel, MonacoController, createChannel, languageForPath } = core;
const { tags, attrs, tagMap } = tagPanel;
let tagEditor;
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
const syncSession = (() => {
  const value = new URLSearchParams(location.search).get('readerSession') || '';
  return /^[\w-]{1,128}$/.test(value) ? value : '';
})();
let syncChannel = null;
let combining = false;

async function saveAndCloseForReader(requestId) {
  if (combining) return;
  combining = true;
  const channel = syncChannel;
  const closed = () => channel?.postMessage({ source: 'editor', type: 'editor-combined', requestId });
  try {
    // Revisit earlier tabs if they were edited while a later tab was saving.
    do {
      for (const d of state.docs.values()) await d.saveUntilClean();
    } while ([...state.docs.values()].some(d => d.dirty));
    markDirty(true);
    window.addEventListener('pagehide', closed, { once: true });
    window.close();
    setTimeout(() => {
      window.removeEventListener('pagehide', closed);
      combining = false;
      channel?.postMessage({ source: 'editor', type: 'editor-combine-failed', requestId,
        error: '文件已保存，但浏览器未允许关闭独立编辑窗口' });
    }, 500);
  } catch (error) {
    combining = false;
    notify(error.message);
    channel?.postMessage({ source: 'editor', type: 'editor-combine-failed', requestId, error: error.message });
  }
}

function announceEditorPage() {
  if (!syncChannel || !state.path) return;
  syncChannel.postMessage({ source: 'editor', type: 'editor-page', path: state.path, dirty: Boolean(doc()?.dirty) });
}

function startReaderSync() {
  if (!syncSession) return;
  syncChannel = createChannel(syncSession, message => {
    if (!message || message.source !== 'reader') return;
    if (message.type === 'reader-combine') return saveAndCloseForReader(message.requestId);
    if (combining) return;
    if (message.type === 'reader-page' && message.path) {
      if (message.path === state.path) return announceEditorPage();
      openFile(message.path);
    } else if (message.type === 'reader-ready') announceEditorPage();
  });
  syncChannel.postMessage({ source: 'editor', type: 'editor-ready' });
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
  if (state.docs.has(path)) return notify(`${path} 已经打开`);
  try {
    await createFileAt(path, '');
    await openFile(path);
    ui.tree.scheduleRefresh();
    notify(`Created ${path}`);
  } catch (error) { notify(error.message); }
}
async function saveAs() {
  const d = doc();
  if (!d) return notify('Open a file first');
  const directory = currentDirectory();
  const name = await ui.askFileName({ mode: 'saveAs', directory, initialName: d.path.split('/').pop() });
  if (!name) return;
  const target = joinCurrentDirectory(name);
  if (target === d.path) return save();
  if (state.docs.has(target)) return notify(`${target} 已经打开`);
  const snapshot = d.content;
  try {
    const data = await d.enqueue(() => createFileAt(target, snapshot));
    const oldPath = d.path;
    if (state.docs.get(oldPath) !== d) {
      ui.tree.scheduleRefresh();
      return notify(`Saved as ${data.path}`);
    }
    const wasActive = doc() === d;
    const viewState = wasActive ? editor.saveViewState() : d.viewState;
    state.docs.delete(oldPath);
    clearTimeout(externalCheckTimers.get(oldPath));
    externalCheckTimers.delete(oldPath);
    d.reloadRevision += 1;
    d.path = data.path;
    d.savedContent = snapshot;
    d.mtime = data.mtime;
    d.read = () => api(`/api/file?path=${encodeURIComponent(d.path)}`);
    d.write = value => postJson('/api/save', { path: d.path, ...value });
    if (wasActive) editor.setModel(null);
    d.model?.dispose();
    d.model = null;
    d.viewState = viewState;
    state.docs.set(d.path, d);
    if (wasActive) {
      state.path = d.path;
      switchDoc(d.path);
    } else renderTabs();
    ui.tree.scheduleRefresh();
    notify(`Saved as ${d.path}${d.dirty ? '; newer edits remain unsaved' : ''}`);
  } catch (error) { notify(error.message); }
}
async function openFile(rel) {
  await sessionReady;
  if (closing) return;
  const request = ++openRevision;
  if (state.docs.has(rel)) return switchDoc(rel);
  const epoch = loadEpoch;
  try {
    let loading = pendingOpens.get(rel);
    if (!loading) {
      let canonicalPath = rel;
      loading = DocumentModel.load({
        read: async () => {
          const data = await api(`/api/file?path=${encodeURIComponent(canonicalPath)}`);
          canonicalPath = data.path;
          return data;
        },
        write: snapshot => postJson("/api/save", { path: canonicalPath, ...snapshot })
      }).then(d => Object.assign(d, { path: canonicalPath }));
      pendingOpens.set(rel, loading);
      loading.finally(() => {
        if (pendingOpens.get(rel) === loading) pendingOpens.delete(rel);
      }).catch(() => {});
    }
    const d = await loading;
    if (epoch !== loadEpoch) return;
    if (!state.docs.has(d.path)) state.docs.set(d.path, d);
    if (request === openRevision) switchDoc(d.path);
    else renderTabs();
  } catch (error) { notify(error.message); }
}
async function openSiblingFile(direction) {
  if (!state.path) return notify("Open a file first");
  const request = ++openRevision;
  const parts = state.path.split("/");
  const currentName = parts.pop();
  const dir = parts.join("/");
  try {
    const data = await api(`/api/tree?path=${encodeURIComponent(dir)}`);
    if (request !== openRevision || closing) return;
    const files = data.entries.filter(entry => entry.type === "file");
    const currentIndex = files.findIndex(entry => entry.name === currentName);
    if (currentIndex < 0 || files.length < 2) return notify("No other file in this folder");
    const target = files[(currentIndex + direction + files.length) % files.length];
    await openFile(target.path);
  } catch (e) {
    notify(e.message);
  }
}

function openFileWindow() {
  if (!state.path) return notify("Open a file first");
  const url = new URL(location.href);
  url.searchParams.set("file", state.path);
  url.searchParams.delete("readerSession");
  window.open(url, "_blank");
}
async function save() {
  const d = doc();
  if (!d) return notify("Open a file first");
  const savedText = d.content;
  try {
    const data = await d.save(savedText);
    if (d.path === state.path) markDirty(true);
    else renderTabs();
    notify(`Saved ${data.path}${d.dirty ? "; newer edits remain unsaved" : ""}`);
  } catch (e) {
    notify(e.message);
  }
}
async function saveAll() {
  for (const d of [...state.docs.values()]) {
    if (!d.dirty) continue;
    const savedText = d.content;
    try {
      await d.save(savedText);
    } catch (e) {
      switchDoc(d.path); notify(e.message); return;
    }
  }
  markDirty(true);
  notify([...state.docs.values()].some(d => d.dirty) ? "Saved snapshots; newer edits remain unsaved" : "Saved all");
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
    if (result === "conflict") notify(`External update pending for ${d.path}; close and reopen to reload`);
    else if (result === "updated") applyExternalUpdate(d);
    else if (result === "saved") {
      if (d.path === state.path) markDirty(true);
      else renderTabs();
    }
  } catch (e) {
    notify(`External file unavailable: ${d.path}`);
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
  scheduleSessionBackup();
}
function renderTabs() {
  ui.renderTabs(state.docs.values(), doc());
  scheduleSessionBackup();
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
  const label = monaco.languages.getLanguages().find(item => item.id === language)?.aliases?.[0] || language;
  ui.setLanguage(`${label} · UTF-8`);
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
  notify(`Updated ${d.path}`);
}
function editTag(tag) {
  if (!doc()) return notify('Open a file first');
  if (doc().editable) tagEditor.applyTag(tag);
}
function insertAttr(attr) {
  if (!doc()) return notify('Open a file first');
  if (doc().editable) tagEditor.applyTag(attr);
}
function undo() { source.undo(); }
function redo() { source.redo(); }
function toggleFind() { return source?.toggleFind(); }
async function closeDocs(paths) {
  if (closing) return;
  closing = true;
  ++openRevision;
  ++loadEpoch;
  pendingOpens.clear();
  try {
    for (const path of paths) {
      const d = state.docs.get(path);
      if (!d) continue;
      if (d.dirty) {
        const choice = await ui.askClose(d);
        if (choice === 'cancel' || !choice) break;
        if (choice === 'save') {
          try { await d.saveUntilClean(); }
          catch (error) { notify(error.message); break; }
        }
      }
      if (state.docs.get(path) !== d) continue;
      if (doc() === d) { editor.setModel(null); state.path = ''; }
      state.docs.delete(path);
      clearTimeout(externalCheckTimers.get(path));
      externalCheckTimers.delete(path);
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
function setTheme(dark) {
  ui.setTheme(dark);
  core.setMonacoTheme(monaco, dark);
  refreshPreview();
}
async function initMonaco(api) {
  monaco = api;
  source = new MonacoController(monaco, byId('monacoEditor'), {
    scale: ui.editorScale(), dark: localStorage.getItem('mewDark') === '1'
  });
  tagEditor = new tagPanel.TagEditor(source);
  editor = source.editor;
  editor.onDidChangeCursorPosition(event => {
    ui.setPosition(event.position.lineNumber, event.position.column);
    scheduleSessionBackup();
  });
  editor.onDidScrollChange(scheduleSessionBackup);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, saveAs);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN, newFile);
  // Capture tag shortcuts and keep closed-find option keys from revealing Monaco's standalone widget.
  byId('monacoEditor').addEventListener('keydown', event => {
    if (event.isComposing || event.ctrlKey || event.metaKey || !editor.hasTextFocus()) return;
    if (!event.altKey && !byId('instant').checked) return;
    const key = event.key.toLowerCase();
    const findVisible = editor.getDomNode()?.querySelector('.find-widget')?.classList.contains('visible');
    if (event.altKey && findVisible && ['c', 'w', 'r', 'p'].includes(key)) return;
    const tag = tagMap.get(key);
    const br = event.altKey && event.key === 'Enter';
    const suppressClosedFindOption = event.altKey && key === 'w';
    if (tag || br || suppressClosedFindOption) {
      event.preventDefault(); event.stopPropagation();
      if (tag) editTag(tag);
      else if (br) insertAttr(attrs.find(attr => attr.id === 'BR'));
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
    submitChanges: window.MEWBackend && (() => window.MEWBackend.submitChanges().catch(error => notify(error.message))),
    configureGit: () => { location.href = "../git-editor.html"; },
    newFile, save, saveAs, saveAll, undo, redo, find: toggleFind,
    navigate: openSiblingFile,
    openWindow: openFileWindow,
    closeAll,
    toggleDark: () => setTheme(!ui.isDark()),
    refreshPreview,
    openRaw,
    activePath: () => state.path,
    closeDocuments: closeDocs,
    activateDocument(path) { ++openRevision; switchDoc(path); }
  });
  setTheme(localStorage.getItem('mewDark') === '1');
  sessionReady = restoreSession();
  await sessionReady;
  startReaderSync();
  connectFileEvents(); checkCssUpdate();
  const file = new URLSearchParams(location.search).get('file');
  if (file) openFile(file);
  window.addEventListener('beforeunload', event => {
    persistSession();
    syncChannel?.postMessage({ source: 'editor', type: 'editor-closed', path: state.path });
    if ([...state.docs.values()].some(d => d.dirty)) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('pagehide', persistSession);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistSession();
  });
  window.mewWorkbench = { editor, documents: state.docs, openFile, newFile, saveAs };
}
// The explorer does not depend on Monaco. Load it immediately so an editor
// loader failure or delay cannot leave the file tree blank.
ui.tree.configure({
  read: rel => api(`/api/tree?path=${encodeURIComponent(rel)}`),
  open: rel => editor ? openFile(rel) : notify('编辑器仍在加载'),
  activePath: () => state.path
});
ui.tree.refresh();
core.loadMonaco().then(initMonaco, error => {
  ui.showMonacoError(error);
});
