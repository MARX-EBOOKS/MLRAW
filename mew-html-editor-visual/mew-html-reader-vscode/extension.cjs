const vscode = require("vscode");
const path = require("node:path");
const { readFile: readLocalFile, stat: statLocalFile } = require("node:fs/promises");
function renderBar(webview, tags, attrs, nav, floating = false) {
  const nonce = String(Date.now());
  const tagButtons = tags.map(tag => buttonHtml("insertTag", tag)).join("");
  const attrButtons = attrs.map(attr => buttonHtml("insertAttr", attr, "attr")).join("");
  const navButtons = nav.map(item => buttonHtml(item.type, item, "attr")).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>MEW Tags</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 6px;
      color: var(--vscode-foreground);
      background: var(--vscode-panel-background, var(--vscode-editor-background));
      font: 12px var(--vscode-font-family);
      overflow: auto;
    }
    .bar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
    }
    button {
      min-width: 30px;
      height: 24px;
      padding: 0 7px;
      border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
      border-radius: 4px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font: 600 11px var(--vscode-font-family);
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.attr {
      color: var(--vscode-editor-foreground);
      background: var(--vscode-input-background);
    }
    .spacer { width: 6px; height: 1px; }
  </style>
</head>
<body>
  <div class="bar">
    ${tagButtons}
    <span class="spacer"></span>
    ${attrButtons}
    <span class="spacer"></span>
    ${navButtons}
    ${floating ? '<button class="attr" data-type="showDockedBar" title="关闭独立窗口，返回原停靠位置">返回标签栏 ↙</button>' : '<button class="attr" data-type="openFloatingBar" title="在独立窗口打开标签栏；可在窗口标题栏开启置顶">另窗打开 ↗</button>'}
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    if (${floating}) vscode.setState({ floating: true });
    document.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.type) {
        vscode.postMessage({ type: button.dataset.type, id: button.dataset.id });
      }
    });
  </script>
</body>
</html>`;
}

function buttonHtml(type, item, extraClass = "") {
  const classAttr = extraClass ? ` class="${escapeHtml(extraClass)}"` : "";
  return `<button${classAttr} data-type="${type}" data-id="${escapeHtml(item.id)}" title="${escapeHtml(item.title)}">${escapeHtml(item.label)}</button>`;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[ch]);
}

function pdfHtml(webview, context, pdfUri) {
  const nonce = `${Date.now()}${Math.random()}`.replace(/\D/g, "");
  const at = (...parts) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, ...parts)).toString();
  const slash = value => value.endsWith("/") ? value : `${value}/`;
  const saved = context.workspaceState?.get("mewReader.pdfSession", {});
  const config = {
    sessionState: saved?.document?.pdfUri === pdfUri?.toString(true) ? saved : {},
    core: at("vendor", "pdfjs", "build", "pdf.mjs"),
    worker: at("vendor", "pdfjs", "build", "pdf.worker.mjs"),
    viewer: at("vendor", "pdfjs", "web", "pdf_viewer.mjs"),
    cMap: slash(at("vendor", "pdfjs", "cmaps")),
    fonts: slash(at("vendor", "pdfjs", "standard_fonts")),
    wasm: slash(at("vendor", "pdfjs", "wasm")),
    images: slash(at("vendor", "pdfjs", "web", "images")),
    displaySettings: context.globalState.get("mewReader.pdfDisplaySettings.v1", {})
  };
  const encoded = escapeHtml(JSON.stringify(config));
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${webview.cspSource} blob: data:; img-src ${webview.cspSource} blob: data:; font-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src ${webview.cspSource} blob:"><meta id="reader-config" data-config="${encoded}"><link rel="stylesheet" href="${at("vendor", "pdfjs", "web", "pdf_viewer.css")}"><link rel="stylesheet" href="${at("reader-pdf.css")}"><title>MEW PDF</title></head><body><svg aria-hidden="true" width="0" height="0"><filter id="scanColorFilter" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR id="filterR" type="table" tableValues="0 1"/><feFuncG id="filterG" type="table" tableValues="0 1"/><feFuncB id="filterB" type="table" tableValues="0 1"/></feComponentTransfer></filter></svg><header id="tools"><strong id="title">MEW PDF</strong><div class="tool-group"><button id="direction" title="切换左右/上下翻页">左右翻页</button><button id="settings" title="调整扫描件颜色">显示设置</button></div><div class="tool-group page-tools"><button id="previous" title="上一页" aria-label="上一页">‹</button><input id="pageNumber" type="text" value="1" aria-label="PDF 页码或页码标签"><span>/</span><output id="pageCount">0</output><button id="next" title="下一页" aria-label="下一页">›</button></div><div class="tool-group zoom-tools"><button id="minus" title="缩小">−</button><input id="zoom" value="页宽" aria-label="PDF 缩放"><button id="plus" title="放大">＋</button></div><button id="copyImage" title="复制本页像素尺寸最大的内嵌原图">复制本页图片</button></header><div id="stage"><div id="viewer" class="pdfViewer"></div></div><p id="status">等待 HTML 页面…</p><dialog id="settingsDialog"><form method="dialog"><header><strong>扫描件显示设置</strong><button value="close" aria-label="关闭">×</button></header><label>亮度 <output id="brightnessValue">100%</output><input id="brightness" type="range" min="50" max="160" value="100"></label><label>背景色 <input id="paper" type="color" value="#ffffff"></label><label>文字色 <input id="ink" type="color" value="#000000"></label><label class="toggle"><input id="invert" type="checkbox">反色</label><footer><button id="reset" type="button">恢复默认</button><button value="close">完成</button></footer></form></dialog><script type="module" nonce="${nonce}" src="${at("reader-pdf.js")}"></script></body></html>`;
}


// An extension-host restart leaves resolved custom-editor inputs connected to
// the dead host. A window reload instead resolves them normally. Give that
// resolver a chance first, then replace only inputs that never attached.
function restorePdfTabs(context, reader) {
  const savedTabs = (vscode.window.tabGroups?.all || []).flatMap(group =>
    group.tabs.filter(tab => tab.input?.viewType === "mewReader.pdf").map(tab => ({ group, tab })));
  const timer = setTimeout(async () => {
    try {
      for (const { group, tab } of savedTabs) {
        if (reader.panel || reader.resolvingPdf || !vscode.window.tabGroups.all.includes(group) || !group.tabs.includes(tab)) continue;
        // Keep the group (including its auxiliary window) alive while replacing
        // its last tab. The placeholder never owns document data.
        const holder = vscode.window.createWebviewPanel("mewReader.restoring", "正在恢复 PDF…",
          { viewColumn: group.viewColumn, preserveFocus: true }, {});
        try {
          if (!await vscode.window.tabGroups.close(tab, true)) continue;
          await vscode.commands.executeCommand("vscode.openWith", tab.input.uri, "mewReader.pdf",
            { viewColumn: holder.viewColumn, preserveFocus: true, preview: false });
        } finally { holder.dispose(); }
      }
    } catch (error) { reader.report(error); }
  }, 1000);
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}

function savePdfState(context, message) {
  if (message?.type === "pdfDisplaySettings") return context.globalState.update("mewReader.pdfDisplaySettings.v1", message.settings);
  if (message?.type === "pdfState") return context.workspaceState?.update("mewReader.pdfSession", message.state);
}



const { findConfig, resolveUri, sortExplorerFiles, formatPattern, pageFromName, pageFromPdfLabel, adjacentPage, pageAtOrBefore, normalizedVolumes, isInside } = require("./reader-core.cjs");

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
const nav = [
  { type: "openPreviousFile", id: "openPreviousFile", label: "←", title: "Open Previous File in Folder" },
  { type: "openNextFile", id: "openNextFile", label: "→", title: "Open Next File in Folder" }
];
const PDF_PANEL_VIEW_TYPE = "mewReader.pdf";

const blockTagNames = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6"]);
const blockTagIds = new Set(["p", "r", "c", "h1", "h2", "h3", "h4", "h5", "h6", "div"]);
const inlineTagIds = new Set(["i", "b", "u", "em", "span"]);
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
        close = tag.close + text.slice(wrapper.closeStart, wrapper.end);
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

  async applyTag(item) {
    const editor = this.editor;
    const tag = item.open !== undefined ? item : null;
    const text = editor.getValue(), selections = editor.selections?.() || [editor.selection()];
    if (tag) this.detect(text);
    const source = tag ? "mew.tag" : "mew.attr";
    const operations = selections.map(({ start, end }) => tag ? this.buildTagEdit(start, end, tag) : {
      start, end, text: item.text, selectStart: item.cursorOffset ?? item.text.length,
      selectEnd: item.cursorOffset ?? item.text.length
    });
    let applied;
    if (operations.length === 1) {
      const op = operations[0];
      applied = await editor.replaceRange(op.text, op.start, op.end, op.start + op.selectStart, op.start + op.selectEnd, source);
      if (tag) editor.editor?.revealRangeInCenterIfOutsideViewport(editor.editor.getSelection());
    } else {
      const edits = new Map(), targets = [];
      for (const operation of operations) {
        const pair = tag && this.detected.byStart.get(operation.start);
        const inner = pair && text.slice(pair.openEnd, pair.closeStart);
        const inline = pair && blockTagNames.has(pair.name) && inlineTagIds.has(tag?.id) &&
          operation.text === text.slice(pair.start, pair.openEnd) + tag.open + inner + tag.close + text.slice(pair.closeStart, pair.end);
        const opening = inline ? text.slice(pair.start, pair.openEnd) + tag.open : tag?.open || "";
        const closing = inline ? tag.close + text.slice(pair.closeStart, pair.end) : tag?.close || "";
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
      applied = await editor.replaceRanges(changes, targets.map(({ operation: op, start, end }) => op ? {
        start: offset(op.start, op) + op.selectStart, end: offset(op.start, op) + op.selectEnd
      } : { start: offset(start), end: offset(end) }), source);
    }
    if (applied === false) return;
    await editor.focus();
    return operations[0];
  }
}

let lastEditor;
let reader;

function activate(context) {
  reader = new ReaderController(context);
  lastEditor = vscode.window.activeTextEditor;
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      lastEditor = editor;
      reader.sync(editor.document.uri).catch(reader.report);
    }
  }));

  const provider = new TagBarViewProvider(context);
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer("mewReader.floatingBar", provider));
  restorePdfTabs(context, reader);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("mewReader.bar", provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(PDF_PANEL_VIEW_TYPE, reader, {
    supportsMultipleEditorsPerDocument: false,
    webviewOptions: { retainContextWhenHidden: true }
  }));
  context.subscriptions.push(
    vscode.commands.registerCommand("mewReader.showBar", () => provider.show()),
    vscode.commands.registerCommand("mewReader.openFloatingBar", () => provider.openFloating()),
    vscode.commands.registerCommand("mewReader.openPdf", () => reader.open()),
    vscode.commands.registerCommand("mewReader.openPreviousPage", () => openSiblingFile(-1)),
    vscode.commands.registerCommand("mewReader.openNextPage", () => openSiblingFile(1))
  );


  for (const tag of tags) {
    context.subscriptions.push(vscode.commands.registerCommand(`mewReader.insert.${tag.id}`, () => insertTag(tag)));
  }
  for (const attr of attrs) {
    context.subscriptions.push(vscode.commands.registerCommand(`mewReader.insert.${attr.id}`, () => insertTag(attr)));
  }
  if (lastEditor) reader.sync(lastEditor.document.uri).catch(reader.report);
}

async function openSiblingFile(direction) {
  if (await reader.navigate(direction)) return;
  const current = activeFile();
  if (!current || current.uri.scheme === "untitled") {
    vscode.window.showInformationMessage("请先打开一个已保存的文件。");
    return;
  }

  const currentUri = current.uri;
  try {
    const files = await siblingFiles(currentUri, vscode.Uri.joinPath(currentUri, ".."));
    const currentIndex = files.findIndex(file => sameUri(file.uri, currentUri));
    if (currentIndex < 0) return;
    // 循环切换：首文件←到末尾，尾文件→到开头
    const target = files[(currentIndex + direction + files.length) % files.length];
    await vscode.commands.executeCommand("vscode.open", target.uri, {
      viewColumn: current.viewColumn,
      preserveFocus: false
    });
  } catch (error) {
    console.error("MEW Tags could not open the adjacent file.", error);
  }
}

// 点击标签栏按钮时 webview 视图持有焦点，vscode.window.activeTextEditor 为
// undefined，此时直接用 tabGroups 取活动标签容易拿到错误/滞后的标签（导致
// 弹回标签栏第一个文件）。因此优先取活动文本编辑器，webview 夺焦时退回
// lastEditor（最近一次活动的文本编辑器）。
// Images, PDFs and other custom editors do not appear in activeTextEditor.
// Their URI is available through the active tab input instead.
function activeFile() {
  const editor = vscode.window.activeTextEditor || lastEditor;
  if (editor && !editor.document.isUntitled) {
    return { uri: editor.document.uri, viewColumn: editor.viewColumn };
  }

  const group = vscode.window.tabGroups.activeTabGroup;
  const tabUri = uriFromTabInput(group && group.activeTab && group.activeTab.input);
  if (tabUri) return { uri: tabUri, viewColumn: group.viewColumn };
  return undefined;
}

function uriFromTabInput(input) {
  if (!input) return undefined;
  // `uri`: text/custom/notebook editors; `modified`: diff editors;
  // `result`: merge editors. The latter two keep navigation useful there too.
  for (const candidate of [input.uri, input.modified, input.result, input.original]) {
    if (candidate && typeof candidate.scheme === "string" && typeof candidate.toString === "function") {
      return candidate;
    }
  }
  return undefined;
}

const siblingCache = new Map(); // 目录+排序配置 -> { namesKey, files }

async function siblingFiles(currentUri, parentUri) {
  const explorerConfig = vscode.workspace.getConfiguration("explorer", currentUri);
  const options = {
    sortOrder: explorerConfig.get("sortOrder", "default"),
    lexicographicOptions: explorerConfig.get("sortOrderLexicographicOptions", "default"),
    reverse: explorerConfig.get("sortOrderReverse", false)
  };
  const key = `${parentUri.toString(true)}|${options.sortOrder}|${options.lexicographicOptions}|${options.reverse}`;

  // 轻量核对目录条目：文件列表无改动时直接复用缓存，有改动才重建
  const names = (await vscode.workspace.fs.readDirectory(parentUri))
    .filter(([, type]) => !(type & vscode.FileType.Directory))
    .map(([name]) => name);
  const namesKey = names.join("\n");
  const cached = siblingCache.get(key);
  if (cached && cached.namesKey === namesKey && cached.files.some(file => sameUri(file.uri, currentUri))) {
    return cached.files;
  }

  const files = names.map(name => ({ name, uri: vscode.Uri.joinPath(parentUri, name), mtime: 0 }));
  if (options.sortOrder === "modified") {
    await Promise.all(files.map(async file => {
      try { file.mtime = (await vscode.workspace.fs.stat(file.uri)).mtime; } catch { }
    }));
  }
  if (!files.some(file => sameUri(file.uri, currentUri))) {
    files.push({ name: "", uri: currentUri, mtime: 0 });
  }
  const sorted = sortExplorerFiles(files, options);
  siblingCache.set(key, { namesKey, files: sorted });
  return sorted;
}

function sameUri(one, other) {
  return Boolean(one && other && one.toString(true) === other.toString(true));
}

async function showTagBar() {
  try {
    await vscode.commands.executeCommand("mewReader.bar.focus");
  } catch (error) {
    console.error("MEW Tags could not show the tag bar.", error);
  }
}

function targetEditor() {
  const editor = vscode.window.activeTextEditor || lastEditor;
  if (editor?.document.isClosed) return undefined;
  if (editor) lastEditor = editor;
  return editor;
}

const tagEditors = new WeakMap();

async function insertTag(item) {
  const editor = targetEditor();
  if (!editor) return vscode.window.showInformationMessage("Open a text editor before inserting MEW tags or attributes.");
  let engine = tagEditors.get(editor);
  if (!engine) {
    const adapter = {
      getValue: () => editor.document.getText(),
      selections: () => editor.selections.map(selection => ({
        start: editor.document.offsetAt(selection.start), end: editor.document.offsetAt(selection.end)
      })),
      replaceRange(text, start, end, selectStart, selectEnd) {
        return this.replaceRanges([{ text, start, end }], [{ start: selectStart, end: selectEnd }]);
      },
      async replaceRanges(changes, selections) {
        // Reject conflicting ranges as a unit; never silently discard a cursor's edit.
        const ordered = [...changes].sort((a, b) => a.start - b.start || a.end - b.end);
        if (ordered.some((edit, index) => index && edit.start < ordered[index - 1].end)) {
          vscode.window.showInformationMessage("标签替换范围重叠，请调整选区后重试。");
          return false;
        }
        const document = editor.document;
        const applied = await editor.edit(builder => {
          for (const edit of ordered) builder.replace(
            new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.text);
        });
        if (!applied || document.isClosed) return false;
        editor.selections = selections.map(selection => new vscode.Selection(
          document.positionAt(selection.start), document.positionAt(selection.end)));
        editor.revealRange?.(editor.selection, vscode.TextEditorRevealType?.InCenterIfOutsideViewport);
        return true;
      },
      focus: () => vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: true })
    };
    engine = new TagEditor(adapter);
    tagEditors.set(editor, engine);
  }
  return engine.applyTag(item);
}

// Restored tabs are available before VS Code resolves their webviews.
function findPdfTab(uri) {
  for (const group of vscode.window.tabGroups?.all || []) {
    const tab = group.tabs.find(tab => tab.input?.viewType === PDF_PANEL_VIEW_TYPE && tab.input.uri && sameUri(tab.input.uri, uri));
    if (tab) return { group, tab };
  }
}

async function revealReaderTab({ group, tab }) {
  const groups = vscode.window.tabGroups.all;
  for (let i = 0; vscode.window.tabGroups.activeTabGroup !== group && i < groups.length; i++) {
    await waitForTabChange("workbench.action.focusNextGroup", () => vscode.window.tabGroups.activeTabGroup === group);
  }
  if (vscode.window.tabGroups.activeTabGroup !== group) return false;
  for (let i = 0; group.activeTab !== tab && i < group.tabs.length; i++) {
    await waitForTabChange("workbench.action.nextEditorInGroup", () => group.activeTab === tab);
  }
  if (group.activeTab !== tab) return false;
  await focusReaderWindow();
  return true;
}

// Command completion can precede the extension-host tab-state event.
async function waitForTabChange(command, ready) {
  const tabs = vscode.window.tabGroups;
  let finish, timer;
  const changed = new Promise(resolve => { finish = resolve; });
  const check = () => { if (ready()) finish(); };
  const listeners = [tabs.onDidChangeTabGroups?.(check), tabs.onDidChangeTabs?.(check)];
  try {
    timer = setTimeout(finish, 500);
    await vscode.commands.executeCommand(command);
    check();
    await changed;
  } finally {
    clearTimeout(timer);
    for (const listener of listeners) listener?.dispose();
  }
}

async function focusReaderWindow() {
  await vscode.commands.executeCommand("workbench.action.focusWindow");
}

class TagBarViewProvider {
  constructor(context) {
    this.context = context;
    this.panels = new Set();
    this.setFloating(this.findFloating() !== undefined);
    context.subscriptions.push({ dispose: () => { for (const panel of this.panels) panel.dispose(); } });
  }

  findFloating() {
    for (const group of vscode.window.tabGroups?.all || []) {
      const tab = group.tabs.find(tab => ["mewReader.floatingBar", "mainThreadWebview-mewReader.floatingBar"].includes(tab.input?.viewType));
      if (tab) return { group, tab };
    }
  }

  setFloating(value) {
    return vscode.commands.executeCommand("setContext", "mewReader.floating", value);
  }

  async show() {
    if (this.panels.size || this.findFloating()) return this.openFloating();
    return showTagBar();
  }

  configure(webview, floating) {
    webview.options = { enableScripts: true };
    webview.onDidReceiveMessage(message => this.handleMessage(message).catch(reader.report), null, this.context.subscriptions);
    webview.html = renderBar(webview, tags, attrs, nav, floating);
  }

  resolveWebviewView(view) {
    this.configure(view.webview, false);
  }

  attachPanel(panel) {
    if (this.panels.has(panel)) return;
    this.panels.add(panel);
    this.setFloating(true);
    panel.title = "MEW 标签插入栏";
    panel.onDidDispose(() => {
      this.panels.delete(panel);
      if (!this.panels.size) this.setFloating(false);
    }, null, this.context.subscriptions);
    this.configure(panel.webview, true);
  }

  async deserializeWebviewPanel(panel) {
    this.attachPanel(panel);
  }

  async openFloating() {
    if (this.opening) return this.opening;
    this.opening = this.revealFloating();
    try { await this.opening; } finally { this.opening = null; }
  }

  async revealFloating() {
    const existing = this.panels.values().next().value;
    if (existing) {
      existing.reveal(undefined, false);
      await focusReaderWindow();
      await vscode.commands.executeCommand("workbench.action.enableCompactAuxiliaryWindow");
      return;
    }
    const restored = this.findFloating();
    if (restored) {
      if (await revealReaderTab(restored)) await vscode.commands.executeCommand("workbench.action.enableCompactAuxiliaryWindow");
      return;
    }
    const panel = vscode.window.createWebviewPanel("mewReader.floatingBar", "MEW 标签插入栏",
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.attachPanel(panel);
    await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
    await vscode.commands.executeCommand("workbench.action.enableCompactAuxiliaryWindow");
  }

  async showDocked() {
    for (const panel of [...this.panels]) panel.dispose();
    for (const group of vscode.window.tabGroups?.all || []) {
      const tabs = group.tabs.filter(tab => ["mewReader.floatingBar", "mainThreadWebview-mewReader.floatingBar"].includes(tab.input?.viewType));
      if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
    }
    await this.setFloating(false);
    await showTagBar();
  }

  async handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "insertTag" || message.type === "insertAttr") {
      const item = (message.type === "insertTag" ? tags : attrs).find(item => item.id === message.id);
      if (item) return insertTag(item);
    }
    if (message.type === "openFloatingBar") return this.openFloating();
    if (message.type === "showDockedBar") return this.showDocked();
    if (message.type === "openPreviousFile") return openSiblingFile(-1);
    if (message.type === "openNextFile") return openSiblingFile(1);
  }
}

class ReaderController {
  constructor(context) {
    this.context = context;
    this.panel = null;
    this.current = null;
    this.ready = false;
    this.restoredDocument = null;
    this.panelPdfUri = null;
    this.syncRevision = 0;
    this.navigationRevision = 0;
    this.report = error => {
      console.error("MEW Reader", error);
      vscode.window.showErrorMessage(`MEW Reader：${error.message || error}`);
    };
  }

  async sync(uri, forceOpen = false) {
    if (!uri || !/\.html?$/i.test(uri.path)) return false;
    if (!sameUri(uri, this.pdfNavigationTarget)) ++this.navigationRevision;
    const revision = ++this.syncRevision;
    const current = await this.resolvePage(uri);
    if (revision !== this.syncRevision || !current) return false;
    this.current = current;
    this.watchVolume(current.volume);
    if (this.pdfNavigationTarget && sameUri(uri, this.pdfNavigationTarget)) return true;
    this.pdfPageLabel = String(current.page);
    this.restoredDocument = null;
    const autoOpen = vscode.workspace.getConfiguration("mewReader", uri).get("autoOpenPdf", true);
    if (!this.panel && !autoOpen && !forceOpen) return true;
    if (!this.panel || !sameUri(this.panelPdfUri, current.volume.pdfUri)) await this.createPanel(current);
    // openWith can return before a restored custom editor is attached. Its
    // resolver owns the title; the ready handshake sends the pending current.
    await this.sendCurrent();
    return true;
  }

  watchVolume(volume) {
    const key = volume.directoryUri.toString();
    if (this.watchedDirectory === key) return;
    this.fileWatcher?.dispose();
    this.watchedDirectory = key;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(volume.directoryUri, "*"));
    this.fileWatcher = watcher;
    const changed = () => {
      clearTimeout(this.directoryTimer);
      this.directoryTimer = setTimeout(() => this.refreshVolume().catch(this.report), 120);
    };
    watcher.onDidCreate(changed);
    watcher.onDidDelete(changed);
    this.context.subscriptions.push(watcher, { dispose: () => clearTimeout(this.directoryTimer) });
  }

  indexVolume(volume, entries) {
    volume.files = new Map(entries.flatMap(([name, type]) => {
      const page = pageFromName(name, volume.pattern);
      return !(type & vscode.FileType.Directory) && page != null &&
        (!volume.explicitPages.length || volume.explicitPages.includes(page))
        ? [[page, vscode.Uri.joinPath(volume.directoryUri, name)]] : [];
    }));
    volume.pages = [...volume.files.keys()].sort((a, b) => a - b);
  }

  async refreshVolume() {
    const current = this.current;
    if (!current || !this.panel) return;
    const volume = current.volume;
    const entries = await vscode.workspace.fs.readDirectory(volume.directoryUri);
    if (this.current !== current) return;
    this.indexVolume(volume, entries);
    await this.onPdfPage({ pageLabel: this.pdfPageLabel ?? String(current.page) });
  }

  async open() {
    const uri = activeFile()?.uri;
    if (!uri || !(await this.sync(uri, true))) return vscode.window.showInformationMessage("当前 HTML 不在 MEW Reader JSON 配置中。");
    if (this.panel && sameUri(this.panelPdfUri, this.current.volume.pdfUri)) {
      this.panel.reveal(undefined, false);
    await focusReaderWindow();
    } else {
      const restored = findPdfTab(this.current.volume.pdfUri);
      if (restored) await revealReaderTab(restored);
    }
  }

  async navigate(direction) {
    const uri = activeFile()?.uri;
    if (!uri || !/\.html?$/i.test(uri.path)) return false;
    const current = this.current && sameUri(this.current.uri, uri) ? this.current : await this.resolvePage(uri);
    if (!current) return false;
    const page = adjacentPage(current.volume.pages, current.page, direction);
    if (page == null) return true;
    await this.openHtmlPage(current, page);
    return true;
  }

  async openHtmlPage(current, page, preserveFocus = true) {
    const revision = ++this.navigationRevision;
    const target = current.volume.files.get(page);
    if (!target) return;
    const column = targetEditor()?.viewColumn || vscode.ViewColumn.Active;
    const document = await vscode.workspace.openTextDocument(target);
    if (revision !== this.navigationRevision || (preserveFocus && this.current !== current)) return;
    await vscode.window.showTextDocument(document, { viewColumn: column, preserveFocus, preview: true });
    if (revision === this.navigationRevision) await this.sync(target);
  }

  async onPdfPage(message) {
    ++this.navigationRevision;
    const current = this.current;
    if (!current) return;
    this.pdfPageLabel = message.pageLabel;
    const requested = pageFromPdfLabel(message.pageLabel);
    const page = requested == null ? null : pageAtOrBefore(current.volume.pages, requested);
    if (page == null || page === current.page) return;
    this.pdfNavigationTarget = current.volume.files.get(page);
    try { await this.openHtmlPage(current, page, true); }
    finally { this.pdfNavigationTarget = null; }
  }

  async createPanel(current) {
    // Let the custom-editor resolver attach the tab saved by VS Code in place.
    if (findPdfTab(current.volume.pdfUri)) return;
    if (this.openingPanel) {
      await this.openingPanel;
      if (findPdfTab(current.volume.pdfUri) ||
          (this.panel && sameUri(this.panelPdfUri, current.volume.pdfUri))) return;
    }
    this.openingPanel = this.openFloating(current);
    try { await this.openingPanel; }
    finally { this.openingPanel = null; }
  }

  async openFloating(current) {
    const setting = vscode.workspace.getConfiguration("mewReader", current.uri).get("pdfOpenLocation", "beside");
    const column = setting === "active" ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
    await vscode.commands.executeCommand("vscode.openWith", current.volume.pdfUri, PDF_PANEL_VIEW_TYPE, {
      viewColumn: column,
      preserveFocus: setting !== "newWindow",
      preview: false
    });
    if (setting === "newWindow") {
      try {
        await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
        await vscode.commands.executeCommand("workbench.action.enableCompactAuxiliaryWindow");
      }
      catch { vscode.window.showWarningMessage("MEW Reader：当前 VS Code 不支持自动把 PDF 页签移到新窗口，已保留在右侧。"); }
    }
  }

  openCustomDocument(uri) {
    this.resolvingPdf = true;
    return { uri, dispose() {} };
  }

  resolveCustomEditor(document, panel) {
    if (this.current && !sameUri(this.current.volume.pdfUri, document.uri)) this.current = null;
    const fileName = panel.title = path.basename(document.uri.fsPath || document.uri.path);
    this.attachPanel(panel, {
      pdfUri: document.uri.toString(true),
      fileName,
      pageLabel: "1"
    });
  }

  attachPanel(panel, restoredDocument = null) {
    if (this.panel && this.panel !== panel) this.panel.dispose();
    this.panel = panel;
    this.ready = false;
    this.restoredDocument = restoredDocument;
    const pdfUri = restoredDocument?.pdfUri ? vscode.Uri.parse(restoredDocument.pdfUri) : this.current?.volume.pdfUri;
    this.panelPdfUri = pdfUri ?? null;
    this.resolvingPdf = false;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: pdfUri ? [this.context.extensionUri, vscode.Uri.joinPath(pdfUri, "..")] : [this.context.extensionUri]
    };
    // Bind byte access to this custom editor's file, never to a webview-supplied
    // path. Binary postMessage bypasses the webview resource service worker.
    let disposed = false;
    let reading;
    const readController = new AbortController();
    panel.webview.onDidReceiveMessage(message => {
      if (disposed || this.panel !== panel) return;
      if (message?.type === "focusPdf") {
        panel.reveal(undefined, false);
        focusReaderWindow().catch(this.report);
      }
      if (message?.type === "copyImageError") vscode.window.showErrorMessage(`复制图片失败：${String(message.error)}`);
      if (message?.type === "pdfDataRequest" && Number.isSafeInteger(message.id) && pdfUri?.scheme === "file") {
        reading ||= statLocalFile(pdfUri.fsPath).then(info => info.size <= 128 * 1024 * 1024
          ? readLocalFile(pdfUri.fsPath, { signal: readController.signal }) : null);
        const request = reading;
        request.then(bytes => {
          if (!disposed) return panel.webview.postMessage({ type: "pdfData", id: message.id,
            data: bytes ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null });
        }, error => {
          if (!disposed) return panel.webview.postMessage({ type: "pdfData", id: message.id, error: error.message });
        }).catch(this.report).finally(() => { if (reading === request) reading = null; });
      }
      if (message?.type === "ready") {
        this.ready = true;
        this.acceptRestoredDocument(message.document);
        this.sendCurrent().catch(this.report);
      }
      if (message?.type === "pdfPageChange") this.onPdfPage(message).catch(this.report);
      savePdfState(this.context, message)?.catch(this.report);
    }, null, this.context.subscriptions);
    panel.onDidDispose(() => {
      disposed = true;
      readController.abort();
      if (this.panel !== panel) return;
      this.panel = null;
      this.ready = false;
      this.restoredDocument = null;
      this.panelPdfUri = null;
    }, null, this.context.subscriptions);
    // Register the handshake before starting the webview, including restoration.
    panel.webview.html = pdfHtml(panel.webview, this.context, pdfUri);
    panel.webview.postMessage({ type: "requestReady" }).then(undefined, this.report);
  }

  acceptRestoredDocument(value) {
    if (!value || typeof value !== "object") return;
    const restored = Object.fromEntries(["htmlUri", "pdfUri", "fileName", "pageLabel"]
      .filter(key => typeof value[key] === "string" && value[key]).map(key => [key, value[key]]));
    if (!restored.pdfUri || (this.panelPdfUri && restored.pdfUri !== this.panelPdfUri.toString(true))) return;
    this.restoredDocument = restored;
    if (restored.htmlUri && !this.current) {
      const uri = vscode.Uri.parse(restored.htmlUri);
      if (/\.html?$/i.test(uri.path)) this.resolvePage(uri).then(current => {
        if (!current || this.current) return;
        this.current = current;
        this.sendCurrent();
      }).catch(error => console.warn("MEW Reader could not resolve the restored HTML page", error));
    }
  }

  async sendCurrent() {
    if (!this.panel || !this.ready) return;
    const current = this.current;
    const document = this.restoredDocument?.htmlUri === current?.uri.toString(true) ? this.restoredDocument : current ? {
      htmlUri: this.current.uri.toString(true),
      pdfUri: current.volume.pdfUri.toString(true),
      fileName: path.basename(current.volume.pdfUri.fsPath || current.volume.pdfUri.path),
      pageLabel: formatPattern(current.volume.pageLabel, current.page, current.volume.id)
    } : this.restoredDocument;
    if (!document?.pdfUri) return;
    const pdfUri = vscode.Uri.parse(document.pdfUri);
    // The custom editor owns one PDF; a pending switch must not retarget its data bridge.
    if (!sameUri(pdfUri, this.panelPdfUri)) return;
    await this.panel.webview.postMessage({
      type: "showPdf",
      ...document,
      nativeData: pdfUri.scheme === "file",
      url: this.panel.webview.asWebviewUri(pdfUri).toString()
    });
  }

  async resolvePage(uri) {
    const known = this.knownPage(uri);
    if (known) return known;
    const configUri = await findConfig(vscode, uri);
    if (!configUri) return null;
    const raw = await vscode.workspace.fs.readFile(configUri);
    let json;
    try { json = JSON.parse(Buffer.from(raw).toString("utf8")); }
    catch (error) { throw new Error(`${configUri.fsPath || configUri.path} 不是有效 JSON：${error.message}`); }
    const base = vscode.Uri.joinPath(configUri, "..");
    for (const spec of normalizedVolumes(json)) {
      const directoryUri = resolveUri(vscode, base, spec.directory);
      if (!isInside(path.resolve(uri.fsPath), path.resolve(directoryUri.fsPath))) continue;
      const page = pageFromName(path.basename(uri.fsPath), spec.pattern);
      if (page == null) continue;
      const entries = await vscode.workspace.fs.readDirectory(directoryUri);
      spec.directoryUri = directoryUri;
      this.indexVolume(spec, entries);
      spec.pdfUri = resolveUri(vscode, base, spec.pdf);
      if (!spec.files.has(page)) return null;
      return { uri, page, volume: spec, configUri };
    }
    return null;
  }

  knownPage(uri) {
    const volume = this.current?.volume;
    if (!volume?.directoryUri || !isInside(path.resolve(uri.fsPath), path.resolve(volume.directoryUri.fsPath))) return null;
    const page = pageFromName(path.basename(uri.fsPath), volume.pattern);
    const file = page == null ? null : volume.files.get(page);
    if (!file || !sameUri(file, uri)) return null;
    return { uri, page, volume, configUri: this.current.configUri };
  }
}

module.exports = { activate, renderBar, pdfHtml, restorePdfTabs, savePdfState };
