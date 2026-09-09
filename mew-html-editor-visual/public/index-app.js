// index.html workbench: file tree, tabs, preview, persistence adapters and UI wiring.
let editor, monaco, source, previewTimer = 0, openRevision = 0, closing = false;
const PREVIEW_DELAY = 200, TAG_PANEL_KEY = 'mewMonacoTagPanel.v1';
const $ = id => document.getElementById(id);
const state = { path: "", docs: new Map(), checkingTree: false, cssText: "", treeText: "" };
const core = window.MewEditorCore;
if (!core) throw new Error('MewEditorCore 未载入');
const { DocumentModel, MonacoController, tags, attrs, tagMap, createChannel, languageForPath } = core;
const editorScale = () => Math.min(1.6, Math.max(.8,
  Number.parseFloat(document.documentElement.style.getPropertyValue('--editor-scale')) || 1));
const applyEditorScale = (scale = editorScale()) => source?.setScale(scale);
window.addEventListener('mew-editor-scale-change', event => applyEditorScale(event.detail));
let saveAllChordTimer = 0, saveAllChordPending = false;

function handleSaveAllChord(event) {
  if (event.isComposing) return;
  const key = event.key.toLowerCase();
  if (saveAllChordPending) {
    if (['control', 'meta', 'shift', 'alt'].includes(key)) return;
    clearTimeout(saveAllChordTimer);
    saveAllChordPending = false;
    if (key !== 's' || event.altKey || event.shiftKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    saveAll();
    return;
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || key !== 'k') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  saveAllChordPending = true;
  clearTimeout(saveAllChordTimer);
  saveAllChordTimer = setTimeout(() => { saveAllChordPending = false; }, 2000);
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
  document.title = 'MEW Monaco Editor · 阅读器联控';
}
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
    row.setAttribute("role", "treeitem");
    if (e.type === "dir") row.setAttribute("aria-expanded", String(open.has(e.path)));
    row.onkeydown = ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); } };
    row.onclick = ev => {
      ev.stopPropagation();
      if (e.type === "dir") return toggleDir(row, e.path).catch(error => note(error.message));
      openFile(e.path);
    };
    box.append(row);
    if (e.type === "dir" && open.has(e.path)) {
      row.firstChild.contentContent = "-";
      await loadTree(e.path, row, open);
    }
  }
  if (rel) host.after(box);
  box.querySelector(`.item[data-path="${CSS.escape(state.path)}"]`)?.classList.add("active");
}
async function toggleDir(row, rel) {
  const next = row.nextElementSibling;
  if (next?.classList.contains("indent")) { next.remove(); row.setAttribute("aria-expanded", "false"); row.firstChild.contentContent = "+"; return; }
  row.firstChild.contentContent = "-";
  row.setAttribute("aria-expanded", "true");
  await loadTree(rel, row);
  filterTree();
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
  $("preview").hidden = false;
  const dir = state.path.split("/").slice(0, -1).join("/");
  const { bg, ink } = themeColors();
  const css = `${state.cssText ? `<style>${state.cssText}</style>` : '<link rel="stylesheet" href="/mewde.css">'}<style>body{background:${bg};color:${ink}}</style>`;
  const baseUrl = window.MEWBackend?.rawUrl(dir, true) || `/raw/${encodeURI(dir)}${dir ? "/" : ""}`;
  const base = `<base href="${baseUrl}">`;
  $("preview").srcdoc = base + css + editor.getValue();
}
function openRaw() {
  if (state.path) {
    const { bg, ink } = themeColors();
    if (window.MEWBackend) return window.MEWBackend.openRaw(state.path, editor.getValue(), state.cssText, { bg, ink });
    window.open(`/raw/${encodeURI(state.path)}?bg=${encodeURIComponent(bg)}&fg=${encodeURIComponent(ink)}`, "_blank");
  }
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
    const tag = e.target.closest("button[data-i]");
    const attr = e.target.closest("button[data-attr]");
    const nav = e.target.closest("button[data-nav]");
    if (tag) editTag(tags[Number(tag.dataset.i)]);
    if (attr) insertAttr(attrs[Number(attr.dataset.attr)]);
    if (nav) openSiblingFile(Number(nav.dataset.nav));
  };
}

function setupTagPanel() {
  let oldLayout = {};
  try { oldLayout = JSON.parse(localStorage.getItem('mew-editor-layout-v1') || '{}'); } catch {}
  if (!window.MewTagPanel) throw new Error('MewTagPanel 未载入');
  window.MewTagPanel.mount({
    content: '#tagBar',
    host: '.editorPane',
    storageKey: TAG_PANEL_KEY,
    initialEditorScale: oldLayout.editorScale,
    initialTagScale: oldLayout.scale,
    setEditorScale(scale) {
      document.documentElement.style.setProperty('--editor-scale', scale);
      window.dispatchEvent(new CustomEvent('mew-editor-scale-change', { detail: scale }));
    },
    editorSelector: '#monacoEditor'
  });
}
const externalCheckTimers = new Map();
let treeRefreshTimer = 0;
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

// Each opened file owns one Monaco model and view state. The workbench's tree,
// tabs, preview and commands all address this same document registry.
function languageLabel(id) {
  const language = monaco.languages.getLanguages().find(item => item.id === id);
  return language?.aliases?.[0] || id;
}
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
function themeColors() {
  const style = getComputedStyle(document.body);
  return { bg: style.getPropertyValue('--bg').trim(), ink: style.getPropertyValue('--ink').trim() };
}
function saveEditorView() {
  const d = doc();
  if (!d || editor.getModel() !== d.model) return;
  d.viewState = editor.saveViewState();
}
function markDirty() {
  const d = doc();
  $('fileName').textContent = d ? d.path + (d.dirty ? ' *' : '') : 'No file open';
  const tagTitle = $('tagPanelTitle');
  tagTitle.textContent = d ? `标签 · ${fileLabel(d.path)}` : '标签';
  tagTitle.title = d?.path || '';
  $('tagPrevFileBtn').disabled = !d;
  $('tagNextFileBtn').disabled = !d;
  renderTabs();
  announceEditorPage();
}
function renderTabs() {
  const tabs = $('tabs');
  tabs.innerHTML = [...state.docs.values()].map(d => `<button class="tab${d === doc() ? ' active' : ''}" data-path="${esc(d.path)}" title="${esc(d.path)}"><span class="tabName">${esc(fileLabel(d.path))}${d.dirty ? ' *' : ''}</span><span class="tabClose" data-close="${esc(d.path)}" title="Close">×</span></button>`).join('');
  tabs.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function setActiveTreePath(path = '') {
  document.querySelectorAll('#tree .item').forEach(row => {
    row.classList.toggle('active', row.dataset.path === path);
    row.setAttribute('aria-selected', String(row.dataset.path === path));
  });
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
  $('languageInfo').textContent = `${languageLabel(language)} · UTF-8`;
  if (d.viewState) editor.restoreViewState(d.viewState);
  setActiveTreePath(path); markDirty(); refreshPreview(); editor.focus();
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
  if (doc().editable) source.applyTag(tag);
}
function insertAttr(attr) {
  if (!doc()) return note('Open a file first');
  if (doc().editable) source.insert(attr);
}
function undo() { source.undo(); }
function redo() { source.redo(); }
function toggleFindReplace() { return source?.toggleFind(); }
function askClose(d) {
  $('closeMessage').textContent = `${d.path} 有未保存的修改，是否保存？`;
  const dialog = $('closeDialog');
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.returnValue = 'cancel'; dialog.showModal();
  });
}
async function closeDocs(paths) {
  if (closing) return;
  closing = true;
  ++openRevision;
  try {
    for (const path of paths) {
      const d = state.docs.get(path);
      if (!d) continue;
      if (d.dirty) {
        const choice = await askClose(d);
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
        $('preview').hidden = true;
        $('preview').srcdoc = '';
        setActiveTreePath();
      }
    }
    markDirty();
  } finally { closing = false; }
}
function closeAll(savedOnly = false) {
  return closeDocs([...state.docs.values()].filter(d => !savedOnly || !d.dirty).map(d => d.path));
}
function filterTree() {
  const q = $('treeFilter').value.toLowerCase();
  document.querySelectorAll('#tree .item').forEach(row => {
    row.hidden = row.dataset.type !== 'dir' && !row.dataset.path.toLowerCase().includes(q);
  });
}
async function revealFile() {
  const parts = state.path.split('/'); parts.pop();
  let path = '';
  for (const part of parts) {
    path += (path ? '/' : '') + part;
    const row = document.querySelector(`#tree .item[data-path="${CSS.escape(path)}"]`);
    if (row && !row.nextElementSibling?.classList.contains('indent')) await toggleDir(row, path);
  }
  $('treeFilter').value = ''; filterTree(); setActiveTreePath(state.path);
  document.querySelector('#tree .active')?.scrollIntoView({ block: 'nearest' });
}

function setDark(on) {
  document.body.classList.toggle('dark', on);
  localStorage.setItem('mewDark', on ? '1' : '0');
  $('darkBtn').textContent = on ? 'Light' : 'Dark';
  const style = getComputedStyle(document.body);
  const color = name => style.getPropertyValue('--' + name).trim().replace(/^#([a-f0-9])([a-f0-9])([a-f0-9])$/i, '#$1$1$2$2$3$3');
  monaco.editor.defineTheme('mew', {
    base: on ? 'vs-dark' : 'vs', inherit: true,
    rules: [
      { token: 'tag', foreground: color('tag').slice(1) },
      { token: 'attribute.name', foreground: color('attr').slice(1) },
      { token: 'attribute.value', foreground: color('string').slice(1) },
      { token: 'comment', foreground: color('comment').slice(1) }
    ],
    colors: { 'editor.background': color('bg'), 'editor.foreground': color('text'),
      'editor.selectionBackground': color('sel'), 'editorLineNumber.foreground': color('muted'),
      'editorWidget.background': color('panel'), 'editorWidget.border': color('line'),
      'input.background': color('field'), 'input.foreground': color('ink'),
      'editorCursor.foreground': color('ink') }
  });
  monaco.editor.setTheme('mew'); refreshPreview();
}

function initialize(api) {
  monaco = api;
  const scale = editorScale();
  source = new MonacoController(monaco, $('monacoEditor'), {
    model: null, automaticLayout: true, fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: 14 * scale, lineHeight: Math.round(21 * scale), tabSize: 2, wordWrap: 'on', minimap: { enabled: false },
    find: { addExtraSpaceOnTop: false },
    // 0.55.1 occurrence requests can reject on rapid model switches.
    occurrencesHighlight: 'off', scrollBeyondLastLine: false, padding: { top: 14, bottom: 14 }
  });
  editor = source.editor;
  editor.onDidChangeCursorPosition(event => {
    $('positionInfo').textContent = `Ln ${event.position.lineNumber}, Col ${event.position.column}`;
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, saveAll);
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
  document.addEventListener('keydown', handleSaveAllChord, true);
  document.addEventListener('keydown', event => {
    if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); if (event.shiftKey) saveAll(); else save();
    }
  });
  buildTagBar(); setupTagPanel();
  $('saveBtn').onclick = save; $('saveAllBtn').onclick = saveAll;
  $('undoBtn').onclick = undo; $('redoBtn').onclick = redo;
  $('findBtn').onclick = toggleFindReplace;
  $('prevFileBtn').onclick = () => openSiblingFile(-1); $('nextFileBtn').onclick = () => openSiblingFile(1);
  $('newWinBtn').onclick = openFileWindow; $('closeSavedBtn').onclick = () => closeAll(true); $('closeAllBtn').onclick = () => closeAll();
  $('darkBtn').onclick = () => setDark(!document.body.classList.contains('dark'));
  $('fullBtn').onclick = toggleFull;
  $('refreshBtn').onclick = refreshPreview; $('openRawBtn').onclick = openRaw;
  $('treeRefreshBtn').onclick = refreshTree;
  $('treeCollapseBtn').onclick = () => {
    document.querySelectorAll('#tree > .indent').forEach(el => el.remove());
    document.querySelectorAll('#tree .item[data-type="dir"]').forEach(row => { row.firstChild.textContent = '+'; row.setAttribute('aria-expanded', 'false'); });
  };
  $('treeRevealBtn').onclick = () => revealFile().catch(error => note(error.message));
  $('treeFilter').oninput = filterTree;
  $('tabs').onclick = event => {
    const close = event.target.closest('[data-close]');
    if (close) return closeDocs([close.dataset.close]);
    const tab = event.target.closest('[data-path]');
    if (tab) { ++openRevision; switchDoc(tab.dataset.path); }
  };
  $('fileMenu').onclick = event => { if (event.target.closest('button')) $('fileMenu').open = false; };
  document.addEventListener('pointerdown', event => closeMenus(event.target.closest('.menu')));
  if (window.MEWBackend) {
    $('submitChangeBtn').hidden = $('gitConfigBtn').hidden = false;
    $('submitChangeBtn').onclick = () => window.MEWBackend.submitChanges().catch(error => note(error.message));
    $('gitConfigBtn').onclick = () => { location.href = '../git-editor.html'; };
  }
  setDark(localStorage.getItem('mewDark') === '1');
  startReaderSync();
  refreshTree(); connectFileEvents(); checkCssUpdate();
  const file = new URLSearchParams(location.search).get('file');
  if (file) openFile(file);
  window.addEventListener('beforeunload', event => {
    readerChannel?.postMessage({ source: 'editor', type: 'editor-closed', path: state.path });
    if ([...state.docs.values()].some(d => d.dirty)) { event.preventDefault(); event.returnValue = ''; }
  });
  window.mewWorkbench = { editor, documents: state.docs, openFile };
}
core.loadMonaco().then(initialize, error => {
  $('status').textContent = `Monaco 加载失败：${error.message || error}`;
});
