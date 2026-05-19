const $ = id => document.getElementById(id);
const state = { path: "", docs: new Map(), checkingFiles: false, checkingTree: false, cssText: "", treeText: "" };
const tags = [
  ["B", "b", "<b>", "</b>", "Alt+B / b"], ["I", "i", "<i>", "</i>", "Alt+I / i"],
  ["Q", "q", "<blockquote>", "</blockquote>", "Alt+Q / q"], ["A", "a", "<a href=\"\" id=\"\">", "</a>", "Alt+A / a"],
  ["ID", "x", "<a id=\"\">", "</a>", "Alt+X / x"],
  ["HREF", "l", "<a href=\"\">", "</a>", "Alt+L / l"], ["FN", "f", "<sup><a href=\"\" id=\"\">", "</a></sup>", "Alt+F / f"],
  ["R", "r", "<p align=\"right\">", "</p>", "Alt+R / r"], ["C", "c", "<p align=\"center\">", "</p>", "Alt+C / c"],
  ["H1", "1", "<h1>", "</h1>", "Alt+1 / 1"], ["H2", "2", "<h2>", "</h2>", "Alt+2 / 2"], ["H3", "3", "<h3>", "</h3>", "Alt+3 / 3"],
  ["H4", "4", "<h4>", "</h4>", "Alt+4 / 4"], ["H5", "5", "<h5>", "</h5>", "Alt+5 / 5"], ["H6", "6", "<h6>", "</h6>", "Alt+6 / 6"],
  ["P", "p", "<p>", "</p>", "Alt+P / p"], ["BR", "Enter", "<br>\n", "", "Alt+Enter"],
  ["DIV", "d", "<div>", "</div>", "Alt+D / d"], ["SPAN", "s", "<span>", "</span>", "Alt+S / s"]
];
const tagMap = Object.fromEntries(tags.map(t => [t[1].toLowerCase(), t]));
const attrButtons = [
  ["ID=", " id=\"\"", 5, "Insert id attribute"],
  ["CLASS=", " class=\"\"", 8, "Insert class attribute"]
];

function api(url, options) {
  return fetch(url, options).then(async r => {
    const type = r.headers.get("content-type") || "";
    const data = type.includes("json") ? await r.json() : await r.text();
    if (!r.ok || data.error) throw new Error(data.error || data);
    return data;
  });
}
function note(msg) { $("status").textContent = msg; setTimeout(() => { if ($("status").textContent === msg) $("status").textContent = ""; }, 2500); }
function esc(s) { return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c])); }
function fileLabel(path) { return path.split("/").pop() || path || "Untitled"; }
function doc() { return state.docs.get(state.path); }
function persistEditor() {
  const d = doc();
  if (!d) return;
  const ed = $("editor");
  d.value = ed.value; d.selA = ed.selectionStart; d.selB = ed.selectionEnd;
}
function markDirty(v) {
  const d = doc();
  if (!d) {
    $("fileName").textContent = "No file open";
    renderTabs();
    return;
  }
  d.value = $("editor").value;
  d.dirty = v ?? d.value !== d.text;
  $("fileName").textContent = d.path + (d.dirty ? " *" : "");
  renderTabs();
}
function renderTabs() {
  const tabs = $("tabs");
  tabs.innerHTML = [...state.docs.values()].map(d => `
    <button class="tab${d.path === state.path ? " active" : ""}" data-path="${esc(d.path)}" title="${esc(d.path)}">
      <span class="tabName">${esc(fileLabel(d.path))}${d.dirty ? " *" : ""}</span>
      <span class="tabClose" data-close="${esc(d.path)}" title="Close">x</span>
    </button>
  `).join("");
}
function remember() {
  const ed = $("editor"), d = doc();
  if (!d) return;
  const last = d.undo[d.undo.length - 1];
  const snap = { text: ed.value, a: ed.selectionStart, b: ed.selectionEnd };
  if (!last || last.text !== snap.text || last.a !== snap.a || last.b !== snap.b) d.undo.push(snap);
  if (d.undo.length > 100) d.undo.shift();
  d.redo = [];
}
function undo() {
  const ed = $("editor"), d = doc(), snap = d?.undo.pop();
  if (!snap) return note("Nothing to undo");
  d.redo.push({ text: ed.value, a: ed.selectionStart, b: ed.selectionEnd });
  ed.value = snap.text; ed.focus(); ed.setSelectionRange(snap.a, snap.b);
  markDirty(); refreshPreview(); updateHighlight(); note("Undone");
}
function redo() {
  const ed = $("editor"), d = doc(), snap = d?.redo.pop();
  if (!snap) return note("Nothing to redo");
  d.undo.push({ text: ed.value, a: ed.selectionStart, b: ed.selectionEnd });
  ed.value = snap.text; ed.focus(); ed.setSelectionRange(snap.a, snap.b);
  markDirty(); refreshPreview(); updateHighlight(); note("Redone");
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
  const scope = rel ? box : host;
  scope.querySelector(`.item[data-path="${CSS.escape(state.path)}"]`)?.classList.add("active");
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
  if (state.checkingTree) return;
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
  const data = await api(`/api/file?path=${encodeURIComponent(rel)}`);
  state.docs.set(data.path, { path: data.path, text: data.text, value: data.text, mtime: data.mtime, dirty: false, matches: [], match: -1, undo: [], redo: [], selA: 0, selB: 0 });
  switchDoc(data.path);
}
function switchDoc(path) {
  persistEditor();
  const d = state.docs.get(path);
  if (!d) return;
  state.path = path;
  $("editor").value = d.value;
  document.querySelectorAll(".item.active").forEach(x => x.classList.remove("active"));
  document.querySelector(`.item[data-path="${CSS.escape(path)}"]`)?.classList.add("active");
  markDirty(d.dirty); refreshPreview(); findAll(); updateHighlight(); $("editor").focus();
  $("editor").setSelectionRange(d.selA || 0, d.selB || 0);
}
function closeDoc(path) {
  const d = state.docs.get(path);
  if (!d) return;
  if (d.dirty && !confirm(`${d.path} has unsaved changes. Close it?`)) return;
  const keys = [...state.docs.keys()];
  const i = keys.indexOf(path);
  state.docs.delete(path);
  if (state.path === path) {
    const next = keys[i + 1] || keys[i - 1] || "";
    state.path = "";
    if (next && state.docs.has(next)) switchDoc(next);
    else {
      $("editor").value = "";
      $("preview").srcdoc = "";
      document.querySelectorAll(".item.active").forEach(x => x.classList.remove("active"));
      markDirty(false); findAll(); updateHighlight();
    }
  } else {
    renderTabs();
  }
}
function closeAll(savedOnly = false) {
  for (const d of [...state.docs.values()]) {
    if (savedOnly && d.dirty) continue;
    closeDoc(d.path);
  }
  note(savedOnly ? "Closed saved windows" : "Closed all windows");
}
function openFileWindow(rel = state.path) {
  if (!rel) return note("Open a file first");
  window.open(`/?file=${encodeURIComponent(rel)}`, "_blank");
}
async function save() {
  const d = doc();
  if (!d) return note("Open a file first");
  try {
    const data = await api("/api/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: d.path, text: $("editor").value, mtime: d.mtime }) });
    d.text = $("editor").value; d.value = d.text; d.mtime = data.mtime; markDirty(false); note(`Saved ${data.path}`);
  } catch (e) {
    note(e.message);
  }
}
async function saveAll() {
  persistEditor();
  for (const d of [...state.docs.values()]) {
    if (!d.dirty) continue;
    try {
      const data = await api("/api/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: d.path, text: d.value, mtime: d.mtime }) });
      d.text = d.value; d.mtime = data.mtime; d.dirty = false;
    } catch (e) {
      switchDoc(d.path); note(e.message); return;
    }
  }
  markDirty(false); note("Saved all");
}
function refreshPreview() {
  if (!state.path) return;
  const dir = state.path.split("/").slice(0, -1).join("/");
  const bg = getComputedStyle(document.body).getPropertyValue("--bg").trim();
  const ink = getComputedStyle(document.body).getPropertyValue("--ink").trim();
  const css = `<link rel="stylesheet" href="/mewde.css?t=${Date.now()}"><style>body{background:${bg};color:${ink}}</style>`;
  const base = `<base href="/raw/${encodeURI(dir)}${dir ? "/" : ""}">`;
  $("preview").srcdoc = base + css + $("editor").value;
}
function openRaw() {
  if (state.path) {
    const bg = getComputedStyle(document.body).getPropertyValue("--bg").trim();
    const fg = getComputedStyle(document.body).getPropertyValue("--ink").trim();
    window.open(`/raw/${encodeURI(state.path)}?bg=${encodeURIComponent(bg)}&fg=${encodeURIComponent(fg)}`, "_blank");
  }
}
function insertTag(t) {
  const ed = $("editor"), [label, key, open, close] = t;
  const a = ed.selectionStart, b = ed.selectionEnd, selected = ed.value.slice(a, b);
  remember();
  if (close && selected.startsWith(open) && selected.endsWith(close)) {
    const inner = selected.slice(open.length, selected.length - close.length);
    ed.setRangeText(inner, a, b, "select");
    ed.setSelectionRange(a, a + inner.length); note(`Removed ${label}`);
  } else if (close && ed.value.slice(a - open.length, a) === open && ed.value.slice(b, b + close.length) === close) {
    ed.setRangeText(selected, a - open.length, b + close.length, "select");
    ed.setSelectionRange(a - open.length, b - open.length); note(`Removed ${label}`);
  } else {
    ed.setRangeText(open + selected + close, a, b, "end");
    if (!selected && close) ed.setSelectionRange(a + open.length, a + open.length);
    note(`Inserted ${label}`);
  }
  ed.focus(); markDirty(); refreshPreview(); updateHighlight();
}
function insertAttr(attr) {
  const ed = $("editor"), a = ed.selectionStart, b = ed.selectionEnd;
  remember();
  ed.setRangeText(attr[1], a, b, "end");
  ed.focus();
  ed.setSelectionRange(a + attr[2], a + attr[2]);
  markDirty(); refreshPreview(); updateHighlight(); note(`Inserted ${attr[0]}`);
}
function buildTagBar() {
  $("tagBar").innerHTML = [
    ...tags.map((t, i) => `<button class="tag" data-i="${i}" title="${esc(t[4])}">${esc(t[0])}</button>`),
    ...attrButtons.map((t, i) => `<button class="tag attrTag" data-attr="${i}" title="${esc(t[3])}">${esc(t[0])}</button>`)
  ].join("");
  $("tagBar").onclick = e => {
    const tag = e.target.closest("button[data-i]");
    const attr = e.target.closest("button[data-attr]");
    if (tag) insertTag(tags[Number(tag.dataset.i)]);
    if (attr) insertAttr(attrButtons[Number(attr.dataset.attr)]);
  };
}
function makePattern() {
  const q = $("findText").value;
  if (!q) return null;
  return $("regexBox").checked ? new RegExp(q, "g" + ($("caseBox").checked ? "" : "i")) : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g" + ($("caseBox").checked ? "" : "i"));
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
function gotoMatch(next = true) {
  findAll();
  const d = doc();
  if (!d?.matches.length) return;
  d.match = next ? (d.match + 1) % d.matches.length : Math.max(0, d.match - 1);
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
  ed.setRangeText($("replaceText").value, a, b, "end"); markDirty(); refreshPreview(); updateHighlight(); gotoMatch();
}
function replaceAll() {
  let re; try { re = makePattern(); } catch (e) { return $("findInfo").textContent = e.message; }
  if (!re) return;
  const ed = $("editor"), before = ed.value;
  const count = (before.match(re) || []).length;
  remember();
  ed.value = before.replace(re, $("replaceText").value);
  markDirty(); refreshPreview(); updateHighlight(); findAll(); $("findInfo").textContent = `Replaced ${count}`;
}
function filterTree() {
  const q = $("treeFilter").value.toLowerCase();
  document.querySelectorAll("#tree .item, #tree + .indent .item, .indent .item").forEach(row => {
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
    const k = e.key === "Enter" ? "Enter" : e.key.toLowerCase();
    if (tagMap[k]) { e.preventDefault(); insertTag(tagMap[k]); }
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
  if (d.path !== state.path) return renderTabs();
  const ed = $("editor");
  const a = Math.min(ed.selectionStart, data.text.length), b = Math.min(ed.selectionEnd, data.text.length);
  ed.value = data.text;
  ed.setSelectionRange(a, b);
  markDirty(false); refreshPreview(); findAll(); updateHighlight();
  note(`Updated ${d.path}`);
}
async function checkExternalUpdates() {
  if (state.checkingFiles || !state.docs.size) return;
  state.checkingFiles = true;
  try {
    for (const d of state.docs.values()) {
      const data = await api(`/api/file?path=${encodeURIComponent(d.path)}`);
      if (data.mtime === d.mtime || data.text === d.text) { d.mtime = data.mtime; continue; }
      if (d.dirty || (d.path === state.path && $("editor").value !== d.text)) {
        note(`External update pending for ${d.path}; save or close local edits first`);
      } else {
        applyExternalUpdate(d, data);
      }
    }
  } catch (e) {
    note(e.message);
  } finally {
    state.checkingFiles = false;
  }
}
async function checkCssUpdate() {
  try {
    const text = await fetch(`/mewde.css?t=${Date.now()}`, { cache: "no-store" }).then(r => r.text());
    if (state.cssText && text !== state.cssText) refreshPreview();
    state.cssText = text;
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

buildTagBar(); refreshTree();
$("editor").addEventListener("beforeinput", remember);
$("editor").addEventListener("input", () => { markDirty(); refreshPreview(); updateHighlight(); });
$("editor").addEventListener("scroll", syncHighlightScroll);
$("editor").addEventListener("keydown", keydown);
$("editor").addEventListener("click", openEditorLink);
document.addEventListener("keydown", keydown);
$("saveBtn").onclick = save; $("saveAllBtn").onclick = saveAll; $("undoBtn").onclick = undo; $("redoBtn").onclick = redo;
$("newWinBtn").onclick = () => openFileWindow(); $("closeSavedBtn").onclick = () => closeAll(true); $("closeAllBtn").onclick = () => closeAll(false);
$("darkBtn").onclick = () => { setDark(!document.body.classList.contains("dark")); refreshPreview(); };
$("fullBtn").onclick = toggleFull;
$("refreshBtn").onclick = refreshPreview; $("openRawBtn").onclick = openRaw;
$("findBtn").onclick = () => gotoMatch(); $("nextBtn").onclick = () => gotoMatch(); $("replaceBtn").onclick = replaceOne; $("allBtn").onclick = replaceAll;
$("findText").oninput = findAll; $("regexBox").onchange = findAll; $("caseBox").onchange = findAll; $("treeFilter").oninput = filterTree;
$("fileMenu").addEventListener("click", e => {
  if (e.target.closest(".menuPanel button")) $("fileMenu").open = false;
});
document.addEventListener("pointerdown", e => {
  const menu = e.target.closest(".menu");
  if (menu) return closeMenus(menu);
  closeMenus();
});
$("tabs").onclick = e => {
  const close = e.target.closest("[data-close]");
  if (close) { e.stopPropagation(); return closeDoc(close.dataset.close); }
  const tab = e.target.closest(".tab[data-path]");
  if (tab) switchDoc(tab.dataset.path);
};
setDark(localStorage.getItem("mewDark") === "1");
const startFile = new URLSearchParams(location.search).get("file");
if (startFile) openFile(startFile);
updateHighlight();
setInterval(checkExternalUpdates, 1500);
setInterval(refreshTree, 3000);
setInterval(checkCssUpdate, 1500);
window.addEventListener("beforeunload", e => {
  persistEditor();
  if ([...state.docs.values()].some(d => d.dirty)) { e.preventDefault(); e.returnValue = ""; }
});
