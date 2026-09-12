const vscode = require("vscode");
const path = require("node:path");
const { readFile: readLocalFile, stat: statLocalFile } = require("node:fs/promises");
const { CONFIG_NAMES, formatPattern, pageFromName, pageFromPdfLabel, adjacentPage, pageAtOrBefore, normalizedVolumes, isInside } = require("./reader-core.cjs");

const tags = [
  { id: "b", label: "B", open: "<b>", close: "</b>", title: "Alt+B" },
  { id: "i", label: "I", open: "<i>", close: "</i>", title: "Alt+I" },
  { id: "em", label: "EM", open: "<em>", close: "</em>", title: "Insert emphasis" },
  { id: "q", label: "Q", open: "<blockquote>", close: "</blockquote>", title: "Alt+Q" },
  { id: "a", label: "A", open: "<a href=\"\" id=\"\">", close: "</a>", title: "Alt+A" },
  { id: "x", label: "AID", open: "<a id=\"\">", close: "</a>", title: "Alt+X" },
  { id: "l", label: "HREF", open: "<a href=\"\">", close: "</a>", title: "Alt+L" },
  { id: "f", label: "FN", open: "<sup><a href=\"\" id=\"\">", close: "</a></sup>", title: "Alt+F" },
  { id: "r", label: "R", open: "<p align=\"right\">", close: "</p>", title: "Alt+R" },
  { id: "c", label: "C", open: "<p align=\"center\">", close: "</p>", title: "Alt+C" },
  { id: "ltgt", label: "&lt;&gt;", open: "&lt;", close: "&gt;", title: "Insert angle bracket" },
  { id: "h1", label: "H1", open: "<h1>", close: "</h1>", title: "Alt+1" },
  { id: "h2", label: "H2", open: "<h2>", close: "</h2>", title: "Alt+2" },
  { id: "h3", label: "H3", open: "<h3>", close: "</h3>", title: "Alt+3" },
  { id: "h4", label: "H4", open: "<h4>", close: "</h4>", title: "Alt+4" },
  { id: "h5", label: "H5", open: "<h5>", close: "</h5>", title: "Alt+5" },
  { id: "h6", label: "H6", open: "<h6>", close: "</h6>", title: "Alt+6" },
  { id: "p", label: "P", open: "<p>", close: "</p>", title: "Alt+P" },
  { id: "div", label: "DIV", open: "<div>", close: "</div>", title: "Alt+D" },
  { id: "span", label: "SPAN", open: "<span>", close: "</span>", title: "Alt+S" },
  { id: "aside", label: "ASIDE", open: "<aside>", close: "</aside>", title: "Aside" },
  { id: "sup", label: "SUP", open: "<sup>", close: "</sup>", title: "Insert Superscript" },
  { id: "sub", label: "SUB", open: "<sub>", close: "</sub>", title: "Insert Subscript" },
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
const BLOCK_IDS = new Set(["p", "r", "c", "h1", "h2", "h3", "h4", "h5", "h6", "div"]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TAGS = new Set(["script", "style", "textarea", "title"]);
const PDF_DISPLAY_SETTINGS_KEY = "mewReader.pdfDisplaySettings.v1";
const PDF_PANEL_VIEW_TYPE = "mewReader.pdf";
const TAG_PATTERN = /<!--[\s\S]*?-->|<\/?[A-Za-z][\w:-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;

function buildTagEdit(text, start, end, tag) {
  const elements = tagPairs(text);
  const selected = text.slice(start, end);
  const name = tagName(tag.open);
  const complete = start < end && isCompleteSelection(text, elements, start, end);
  const exact = complete && elements.find(element => element.start === start && element.end === end);

  // 完整选中就是操作外层；否则只操作包住选区的最内层。
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
      if (open?.name === name) {
        // 正常闭合：仍然优先按同名标签配对。
        stack.pop();
        pairs.push({ name: open.name, closeName: name, start: open.start, openEnd: open.end, closeStart: match.index, end: TAG_PATTERN.lastIndex, open: open.token });
        if (name === rawName) rawName = undefined;
      } else {
        const crossed = stack.map(item => item.name).lastIndexOf(name);
        if (crossed >= 0) {
          // 存在同名开始标签时，沿用原来的交叉标签恢复逻辑。
          stack.length = crossed;
        } else if (open) {
          // 容错：结束标签名称不一致时，以最近的开始标签为准。
          // 例如 <p align="center">text</h1> 会被视作一个 p 元素，
          // 从而可以用 C 删除外层，或用 H1/P/DIV 等替换整个外层。
          stack.pop();
          pairs.push({ name: open.name, closeName: name, start: open.start, openEnd: open.end, closeStart: match.index, end: TAG_PATTERN.lastIndex, open: open.token });
        }
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
    vscode.commands.registerCommand("mewReader.showBar", () => provider.panel ? provider.openFloating() : provider.showDocked()),
    vscode.commands.registerCommand("mewReader.openFloatingBar", () => provider.openFloating()),
    vscode.commands.registerCommand("mewReader.openPdf", () => reader.open()),
    vscode.commands.registerCommand("mewReader.openPreviousPage", () => openSiblingFile(-1)),
    vscode.commands.registerCommand("mewReader.openNextPage", () => openSiblingFile(1))
  );


  for (const tag of tags) {
    context.subscriptions.push(vscode.commands.registerCommand(`mewReader.insert.${tag.id}`, () => insertTag(tag)));
  }
  for (const attr of attrs) {
    context.subscriptions.push(vscode.commands.registerCommand(`mewReader.insert.${attr.id}`, () => insertAttr(attr)));
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

// —— 与 VS Code 资源管理器文件列表一致的排序（约 30 行）——
function sortExplorerFiles(files, { sortOrder = "default", lexicographicOptions: lex = "default", reverse = false } = {}) {
  const direction = reverse ? -1 : 1;
  const collator = new Intl.Collator(undefined, { numeric: true });
  const extCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "accent" });
  const compareWith = (c, a, b) => c.compare(a, b) || (a.length < b.length ? -1 : a.length > b.length ? 1 : 0);
  const charCase = ch => /[A-Z]/.test(ch) ? 1 : /[a-z]/.test(ch) ? -1 : ch.toLocaleLowerCase() !== ch ? 1 : ch.toLocaleUpperCase() !== ch ? -1 : 0;
  const caseResult = (a, b) => {
    if (lex !== "upper" && lex !== "lower") return 0;
    const ca = charCase(a.charAt(0)), cb = charCase(b.charAt(0));
    return ca && cb && ca !== cb ? (lex === "upper" ? cb - ca : ca - cb) : 0;
  };
  const extension = name => {
    const match = /^(.*?)(\.([^.]*))?$/.exec(name);
    return match && match[1] && match[1].charAt(0) !== "." && match[3] ? match[3] : "";
  };
  const byName = (a, b) => lex === "unicode" ? (a === b ? 0 : a < b ? -1 : 1) : caseResult(a, b) || compareWith(collator, a, b);
  const byExtension = (a, b) => {
    if (lex === "unicode") {
      const x = extension(a).toLowerCase(), y = extension(b).toLowerCase();
      return (x === y ? 0 : x < y ? -1 : 1) || (a === b ? 0 : a < b ? -1 : 1);
    }
    return compareWith(extCollator, extension(a), extension(b)) || caseResult(a, b) || compareWith(collator, a, b);
  };
  const byFile = (a, b) => sortOrder === "type" ? byExtension(a.name, b.name)
    : sortOrder === "modified" && a.mtime !== b.mtime ? (a.mtime < b.mtime ? 1 : -1) : byName(a.name, b.name);
  return [...files].sort((a, b) => direction * byFile(a, b));
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

async function insertTag(tag) {
  const editor = targetEditor();
  if (!editor) {
    vscode.window.showInformationMessage("Open a text editor before inserting MEW tags.");
    return;
  }

  const document = editor.document;
  const fullText = document.getText();
  const operations = uniqueOperations(editor.selections
    .map(selection => buildTagOperation(document, fullText, selection, tag))
    .sort((a, b) => a.start - b.start));

  await editor.edit(edit => {
    for (const operation of operations) {
      edit.replace(new vscode.Range(document.positionAt(operation.start), document.positionAt(operation.end)), operation.text);
    }
  });

  editor.selections = finalSelections(editor.document, operations);
  await vscode.window.showTextDocument(editor.document, editor.viewColumn, false);
}

function buildTagOperation(document, fullText, selection, tag) {
  const start = document.offsetAt(selection.start);
  const end = document.offsetAt(selection.end);
  return buildTagEdit(fullText, start, end, tag);
}

function uniqueOperations(operations) {
  return operations.filter((operation, index) => {
    if (index === 0) return true;
    const previous = operations[index - 1];
    return operation.start >= previous.end ||
      (operation.start === operation.end && previous.start === previous.end);
  });
}
async function insertAttr(attr) {
  const editor = targetEditor();
  if (!editor) {
    vscode.window.showInformationMessage("Open a text editor before inserting MEW attributes.");
    return;
  }

  const document = editor.document;
  const operations = editor.selections
    .map(selection => {
      const start = document.offsetAt(selection.start);
      const end = document.offsetAt(selection.end);
      return { start, end, text: attr.text, selectStart: attr.cursorOffset, selectEnd: attr.cursorOffset };
    })
    .sort((a, b) => a.start - b.start);

  await editor.edit(edit => {
    for (const operation of operations) {
      edit.replace(new vscode.Range(document.positionAt(operation.start), document.positionAt(operation.end)), operation.text);
    }
  });

  editor.selections = finalSelections(editor.document, operations);
  await vscode.window.showTextDocument(editor.document, editor.viewColumn, false);
}

function finalSelections(document, operations) {
  const selections = [];
  let delta = 0;
  for (const operation of operations) {
    const finalStart = operation.start + delta + operation.selectStart;
    const finalEnd = operation.start + delta + operation.selectEnd;
    selections.push(new vscode.Selection(document.positionAt(finalStart), document.positionAt(finalEnd)));
    delta += operation.text.length - (operation.end - operation.start);
  }
  return selections;
}

class TagBarViewProvider {
  constructor(context) {
    this.context = context;
  }

  resolveWebviewView(view) {
    view.webview.options = { enableScripts: true };
    view.webview.html = renderBar(view.webview);
    view.webview.onDidReceiveMessage(message => this.handleMessage(message), null, this.context.subscriptions);
  }

  handleMessage(message) {
    if (message?.type === "openFloatingBar") return this.openFloating();
    if (message?.type === "showDockedBar") return this.showDocked();
    return handleBarMessage(message);
  }

  async showDocked() {
    await vscode.commands.executeCommand("setContext", "mewReader.floating", false);
    this.panel?.dispose();
    await showTagBar();
  }

  async attachPanel(panel) {
    this.panel = panel;
    this.context.subscriptions.push(panel);
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.panel = undefined;
      vscode.commands.executeCommand("setContext", "mewReader.floating", false);
    });
    panel.webview.options = { enableScripts: true };
    panel.webview.onDidReceiveMessage(message => this.handleMessage(message));
    panel.webview.html = renderBar(panel.webview, true);
    await vscode.commands.executeCommand("setContext", "mewReader.floating", true);
  }

  async deserializeWebviewPanel(panel) {
    if (this.panel) {
      panel.dispose();
      return;
    }
    await this.attachPanel(panel);
  }

  async openFloating() {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn, false);
      await vscode.commands.executeCommand("workbench.action.focusWindow");
      return;
    }
    const panel = vscode.window.createWebviewPanel("mewReader.floatingBar", "MEW 标签插入栏",
      vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    await this.attachPanel(panel);
    try {
      await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
      await vscode.commands.executeCommand("workbench.action.enableCompactAuxiliaryWindow");
    } catch (error) {
      vscode.window.showWarningMessage(`标签栏已打开，另窗或紧密模式未能自动设置：${error.message || error}`);
    }
  }
}

function handleBarMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "insertTag") {
    const tag = tags.find(item => item.id === message.id);
    if (tag) insertTag(tag);
  }
  if (message.type === "insertAttr") {
    const attr = attrs.find(item => item.id === message.id);
    if (attr) insertAttr(attr);
  }
  if (message.type === "openPreviousFile") openSiblingFile(-1);
  if (message.type === "openNextFile") openSiblingFile(1);
}
function renderBar(webview, floating = false) {
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

class ReaderController {
  constructor(context) {
    this.context = context;
    this.panel = null;
    this.current = null;
    this.ready = false;
    this.restoredDocument = null;
    this.panelPdfUri = null;
    this.report = error => {
      console.error("MEW Reader", error);
      vscode.window.showErrorMessage(`MEW Reader：${error.message || error}`);
    };
  }

  async sync(uri, forceOpen = false) {
    if (!uri || !/\.html?$/i.test(uri.path)) return false;
    const current = await this.resolvePage(uri);
    if (!current) return false;
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

  async refreshVolume() {
    const current = this.current;
    if (!current || !this.panel) return;
    const volume = current.volume;
    const entries = await vscode.workspace.fs.readDirectory(volume.directoryUri);
    if (this.current !== current) return;
    const files = new Map();
    for (const [name, type] of entries) {
      if (type & vscode.FileType.Directory) continue;
      const page = pageFromName(name, volume.pattern);
      if (page != null && (!volume.explicitPages.length || volume.explicitPages.includes(page))) {
        files.set(page, vscode.Uri.joinPath(volume.directoryUri, name));
      }
    }
    volume.files = files;
    volume.pages = [...files.keys()].sort((a, b) => a - b);
    await this.onPdfPage({ pageLabel: this.pdfPageLabel ?? String(current.page) });
  }

  async open() {
    const uri = activeFile()?.uri;
    const existing = Boolean(this.panel);
    if (!uri || !(await this.sync(uri, true))) {
      vscode.window.showInformationMessage("当前 HTML 不在 MEW Reader JSON 配置中。");
      return;
    }
    if (existing && this.panel) this.panel.reveal(this.panel.viewColumn, false);
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

  async openHtmlPage(current, page) {
    const target = current.volume.files.get(page);
    if (!target) return;
    const column = targetEditor()?.viewColumn || vscode.ViewColumn.Active;
    const document = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(document, { viewColumn: column, preserveFocus: false, preview: false });
    await this.sync(target);
  }

  async onPdfPage(message) {
    const current = this.current;
    if (!current) return;
    this.pdfPageLabel = message.pageLabel;
    const requested = pageFromPdfLabel(message.pageLabel);
    const page = requested == null ? null : pageAtOrBefore(current.volume.pages, requested);
    if (page == null || page === current.page) return;
    const target = current.volume.files.get(page);
    this.pdfNavigationTarget = target;
    try { await this.openHtmlPage(current, page); }
    finally { if (this.pdfNavigationTarget === target) this.pdfNavigationTarget = null; }
  }

  async createPanel(current) {
    const setting = vscode.workspace.getConfiguration("mewReader", current.uri).get("pdfOpenLocation", "beside");
    const column = setting === "active" ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
    await vscode.commands.executeCommand("vscode.openWith", current.volume.pdfUri, PDF_PANEL_VIEW_TYPE, {
      viewColumn: column,
      preserveFocus: setting !== "newWindow",
      preview: false
    });
    if (setting === "newWindow") {
      try { await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow"); }
      catch { vscode.window.showWarningMessage("MEW Reader：当前 VS Code 不支持自动把 PDF 页签移到新窗口，已保留在右侧。"); }
    }
  }

  openCustomDocument(uri) {
    return { uri, dispose() {} };
  }

  resolveCustomEditor(document, panel) {
    if (this.current && !sameUri(this.current.volume.pdfUri, document.uri)) this.current = null;
    panel.title = path.basename(document.uri.fsPath || document.uri.path);
    this.attachPanel(panel, {
      pdfUri: document.uri.toString(true),
      fileName: path.basename(document.uri.fsPath || document.uri.path),
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
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.resourceRoots(pdfUri)
    };
    // Bind byte access to this custom editor's file, never to a webview-supplied
    // path. Binary postMessage bypasses the webview resource service worker.
    let disposed = false;
    let reading;
    const readController = new AbortController();
    panel.webview.onDidReceiveMessage(message => {
      if (disposed || this.panel !== panel) return;
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
      if (message?.type === "pdfDisplaySettings") {
        this.context.globalState.update(PDF_DISPLAY_SETTINGS_KEY, message.settings).catch(this.report);
      }
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
    panel.webview.html = this.pdfHtml(panel.webview);
  }

  acceptRestoredDocument(value) {
    const restored = this.restoredState({ document: value });
    if (!restored || (this.panelPdfUri && restored.pdfUri !== this.panelPdfUri.toString(true))) return;
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

  restoredState(state) {
    const value = state?.document;
    if (!value || typeof value !== "object") return null;
    const restored = {};
    for (const key of ["htmlUri", "pdfUri", "fileName", "pageLabel"]) {
      if (typeof value[key] === "string" && value[key]) restored[key] = value[key];
    }
    return restored.pdfUri ? restored : null;
  }

  resourceRoots(pdfUri) {
    return pdfUri
      ? [this.context.extensionUri, vscode.Uri.joinPath(pdfUri, "..")]
      : [this.context.extensionUri];
  }

  async sendCurrent() {
    if (!this.panel || !this.ready) return;
    if (!this.current) {
      if (this.restoredDocument) await this.sendDocument(this.restoredDocument);
      return;
    }
    const { volume, page } = this.current;
    await this.sendDocument({
      htmlUri: this.current.uri.toString(true),
      pdfUri: volume.pdfUri.toString(true),
      fileName: path.basename(volume.pdfUri.fsPath || volume.pdfUri.path),
      pageLabel: formatPattern(volume.pageLabel, page, volume.id)
    });
  }

  async sendDocument(document) {
    if (!this.panel || !this.ready || !document?.pdfUri) return;
    const pdfUri = vscode.Uri.parse(document.pdfUri);
    // Only update webview permissions; never reveal the panel here. This lets a user
    // keep the PDF editor in another VS Code window without navigation pulling it back.
    this.panel.webview.options = {
      enableScripts: true, localResourceRoots: this.resourceRoots(pdfUri)
    };
    await this.panel.webview.postMessage({
      type: "showPdf",
      ...document,
      nativeData: pdfUri.scheme === "file",
      url: this.panel.webview.asWebviewUri(pdfUri).toString()
    });
  }

  pdfHtml(webview) {
    const nonce = `${Date.now()}${Math.random()}`.replace(/\D/g, "");
    const at = (...parts) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...parts)).toString();
    const slash = value => value.endsWith("/") ? value : `${value}/`;
    const config = {
      core: at("vendor", "pdfjs", "build", "pdf.mjs"),
      worker: at("vendor", "pdfjs", "build", "pdf.worker.mjs"),
      viewer: at("vendor", "pdfjs", "web", "pdf_viewer.mjs"),
      cMap: slash(at("vendor", "pdfjs", "cmaps")),
      fonts: slash(at("vendor", "pdfjs", "standard_fonts")),
      wasm: slash(at("vendor", "pdfjs", "wasm")),
      images: slash(at("vendor", "pdfjs", "web", "images")),
      displaySettings: this.context.globalState.get(PDF_DISPLAY_SETTINGS_KEY, {})
    };
    const encoded = escapeHtml(JSON.stringify(config));
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${webview.cspSource} blob: data:; img-src ${webview.cspSource} blob: data:; font-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src ${webview.cspSource} blob:"><meta id="reader-config" data-config="${encoded}"><link rel="stylesheet" href="${at("vendor", "pdfjs", "web", "pdf_viewer.css")}"><link rel="stylesheet" href="${at("reader-pdf.css")}"><title>MEW PDF</title></head><body><svg aria-hidden="true" width="0" height="0"><filter id="scanColorFilter" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR id="filterR" type="table" tableValues="0 1"/><feFuncG id="filterG" type="table" tableValues="0 1"/><feFuncB id="filterB" type="table" tableValues="0 1"/></feComponentTransfer></filter></svg><header id="tools"><strong id="title">MEW PDF</strong><div class="tool-group"><button id="direction" title="切换左右/上下翻页">左右翻页</button><button id="settings" title="调整扫描件颜色">显示设置</button></div><div class="tool-group page-tools"><button id="previous" title="上一页" aria-label="上一页">‹</button><input id="pageNumber" type="text" value="1" aria-label="PDF 页码或页码标签"><span>/</span><output id="pageCount">0</output><button id="next" title="下一页" aria-label="下一页">›</button></div><div class="tool-group zoom-tools"><button id="minus" title="缩小">−</button><input id="zoom" value="页宽" aria-label="PDF 缩放"><button id="plus" title="放大">＋</button></div></header><div id="stage"><div id="viewer" class="pdfViewer"></div></div><p id="status">等待 HTML 页面…</p><dialog id="settingsDialog"><form method="dialog"><header><strong>扫描件显示设置</strong><button value="close" aria-label="关闭">×</button></header><label>亮度 <output id="brightnessValue">100%</output><input id="brightness" type="range" min="50" max="160" value="100"></label><label>背景色 <input id="paper" type="color" value="#ffffff"></label><label>文字色 <input id="ink" type="color" value="#000000"></label><label class="toggle"><input id="invert" type="checkbox">反色</label><footer><button id="reset" type="button">恢复默认</button><button value="close">完成</button></footer></form></dialog><script type="module" nonce="${nonce}" src="${at("reader-pdf.js")}"></script></body></html>`;
  }

  async resolvePage(uri) {
    const known = this.knownPage(uri);
    if (known) return known;
    const configUri = await this.findConfig(uri);
    if (!configUri) return null;
    const raw = await vscode.workspace.fs.readFile(configUri);
    let json;
    try { json = JSON.parse(Buffer.from(raw).toString("utf8")); }
    catch (error) { throw new Error(`${configUri.fsPath || configUri.path} 不是有效 JSON：${error.message}`); }
    const base = vscode.Uri.joinPath(configUri, "..");
    for (const spec of normalizedVolumes(json)) {
      const directoryUri = this.resolveUri(base, spec.directory);
      if (!isInside(path.resolve(uri.fsPath), path.resolve(directoryUri.fsPath))) continue;
      const page = pageFromName(path.basename(uri.fsPath), spec.pattern);
      if (page == null) continue;
      const entries = await vscode.workspace.fs.readDirectory(directoryUri);
      const files = new Map();
      for (const [name, type] of entries) {
        if (type & vscode.FileType.Directory) continue;
        const found = pageFromName(name, spec.pattern);
        if (found != null && (!spec.explicitPages.length || spec.explicitPages.includes(found))) files.set(found, vscode.Uri.joinPath(directoryUri, name));
      }
      spec.pages = [...files.keys()].sort((a, b) => a - b);
      spec.files = files;
      spec.directoryUri = directoryUri;
      spec.pdfUri = this.resolveUri(base, spec.pdf);
      if (!files.has(page)) return null;
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


  resolveUri(base, value) {
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) return vscode.Uri.parse(value);
    if (path.isAbsolute(value)) return vscode.Uri.file(value);
    return vscode.Uri.joinPath(base, ...value.replace(/\\/g, "/").split("/"));
  }

  async findConfig(uri) {
    const setting = vscode.workspace.getConfiguration("mewReader", uri).get("configFile", "").trim();
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (setting) {
      const base = workspaceFolder?.uri || vscode.Uri.joinPath(uri, "..");
      const candidate = this.resolveUri(base, setting);
      try { await vscode.workspace.fs.stat(candidate); return candidate; } catch { throw new Error(`找不到配置文件：${candidate.fsPath || candidate.path}`); }
    }
    let directory = vscode.Uri.joinPath(uri, "..");
    const stop = workspaceFolder?.uri;
    while (true) {
      for (const name of CONFIG_NAMES) {
        const candidate = vscode.Uri.joinPath(directory, name);
        try { await vscode.workspace.fs.stat(candidate); return candidate; } catch { }
      }
      if (stop && sameUri(directory, stop)) break;
      const parent = vscode.Uri.joinPath(directory, "..");
      if (sameUri(parent, directory) || (stop && !isInside(path.resolve(parent.fsPath), path.resolve(stop.fsPath)))) break;
      directory = parent;
    }
    return null;
  }
}

function deactivate() { }

module.exports = { activate, deactivate };
