const vscode = require("vscode");

const tags = [
  { id: "b", label: "B", open: "<b>", close: "</b>", title: "Alt+B" },
  { id: "i", label: "I", open: "<i>", close: "</i>", title: "Alt+I" },
  { id: "em", label: "EM", open: "<em>", close: "</em>", title: "Insert emphasis" },
  { id: "q", label: "Q", open: "<blockquote>", close: "</blockquote>", title: "Alt+Q" },
  { id: "a", label: "A", open: "<a href=\"\" id=\"\">", close: "</a>", title: "Alt+A" },
  { id: "x", label: "ID", open: "<a id=\"\">", close: "</a>", title: "Alt+X" },
  { id: "l", label: "HREF", open: "<a href=\"\">", close: "</a>", title: "Alt+L" },
  { id: "f", label: "FN", open: "<sup><a href=\"\" id=\"\">", close: "</a></sup>", title: "Alt+F" },
  { id: "r", label: "R", open: "<p align=\"right\">", close: "</p>", title: "Alt+R" },
  { id: "c", label: "C", open: "<p align=\"center\">", close: "</p>", title: "Alt+C" },
  { id: "h1", label: "H1", open: "<h1>", close: "</h1>", title: "Alt+1" },
  { id: "h2", label: "H2", open: "<h2>", close: "</h2>", title: "Alt+2" },
  { id: "h3", label: "H3", open: "<h3>", close: "</h3>", title: "Alt+3" },
  { id: "h4", label: "H4", open: "<h4>", close: "</h4>", title: "Alt+4" },
  { id: "h5", label: "H5", open: "<h5>", close: "</h5>", title: "Alt+5" },
  { id: "h6", label: "H6", open: "<h6>", close: "</h6>", title: "Alt+6" },
  { id: "p", label: "P", open: "<p>", close: "</p>", title: "Alt+P" },
  { id: "br", label: "BR", open: "<br>\n", close: "", title: "Alt+Enter" },
  { id: "div", label: "DIV", open: "<div>", close: "</div>", title: "Alt+D" },
  { id: "span", label: "SPAN", open: "<span>", close: "</span>", title: "Alt+S" }
];

const attrs = [
  { id: "idAttr", label: "ID=", text: " id=\"\"", cursorOffset: 5, title: "Insert id attribute" },
  { id: "classAttr", label: "CLASS=", text: " class=\"\"", cursorOffset: 8, title: "Insert class attribute" }, 
  { id: "styleAttr", label: "STYLE=", text: " style=\"\"", cursorOffset: 8, title: "Insert style attribute" }
];
const replaceableBlockIds = new Set(["p", "r", "c", "h1", "h2", "h3", "h4", "h5", "h6", "div"]);


let lastEditor;

function activate(context) {
  lastEditor = vscode.window.activeTextEditor;
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor) lastEditor = editor;
  }));

  const provider = new TagBarViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("mewTags.bar", provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("mewTags.showBar", showTagBar)
  );


  for (const tag of tags) {
    context.subscriptions.push(vscode.commands.registerCommand(`mewTags.insert.${tag.id}`, () => insertTag(tag)));
  }
  for (const attr of attrs) {
    context.subscriptions.push(vscode.commands.registerCommand(`mewTags.insert.${attr.id}`, () => insertAttr(attr)));
  }
}

async function showTagBar() {
  try {
    await vscode.commands.executeCommand("mewTags.bar.focus");
  } catch (error) {
    console.error("MEW Tags could not show the tag bar.", error);
  }
}

function targetEditor() {
  const editor = vscode.window.activeTextEditor || lastEditor;
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
  const selected = fullText.slice(start, end);

  if (replaceableBlockIds.has(tag.id)) {
    const block = findReplaceableBlock(fullText, start, end);
    if (block) {
      return blockKindForTag(tag) === blockKindForOpenTag(block.open.token)
        ? removeBlockOperation(fullText, start, end, block)
        : replaceBlockOperation(fullText, start, end, tag, block);
    }
  }

  if (tag.close && selected.startsWith(tag.open) && selected.endsWith(tag.close)) {
    const inner = selected.slice(tag.open.length, selected.length - tag.close.length);
    return { start, end, text: inner, selectStart: 0, selectEnd: inner.length };
  }

  const beforeStart = start - tag.open.length;
  const afterEnd = end + tag.close.length;
  const before = tag.close && beforeStart >= 0 ? fullText.slice(beforeStart, start) : "";
  const after = tag.close && afterEnd <= fullText.length ? fullText.slice(end, afterEnd) : "";
  if (tag.close && before === tag.open && after === tag.close) {
    return { start: beforeStart, end: afterEnd, text: selected, selectStart: 0, selectEnd: selected.length };
  }

  const text = tag.open + selected + tag.close;
  const emptyAttribute = tag.open.indexOf('=""');
  const cursor = emptyAttribute >= 0
    ? emptyAttribute + 2
    : selected ? text.length : tag.open.length;
  return { start, end, text, selectStart: cursor, selectEnd: cursor };
}

function findReplaceableBlock(fullText, selectionStart, selectionEnd) {
  const tagPattern = /<\/?(?:p|h[1-6]|div)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  const stack = [];
  const candidates = [];
  let match;

  while ((match = tagPattern.exec(fullText))) {
    const token = match[0];
    const nameMatch = token.match(/^<\/?(p|h[1-6]|div)\b/i);
    if (!nameMatch) continue;

    const name = nameMatch[1].toLowerCase();
    const isClosing = /^<\//.test(token);
    if (!isClosing && !/\/\s*>$/.test(token)) {
      stack.push({ name, token, start: match.index, end: tagPattern.lastIndex });
      continue;
    }
    if (!isClosing) continue;

    const open = stack.pop();
    if (!open) continue;
    const close = { name, token, start: match.index, end: tagPattern.lastIndex };
    const containsContent = open.end <= selectionStart && selectionEnd <= close.start;
    const selectsWholeBlock = open.start === selectionStart && close.end === selectionEnd;
    if (containsContent || selectsWholeBlock) candidates.push({ open, close });
  }

  return candidates.sort((a, b) =>
    (a.close.end - a.open.start) - (b.close.end - b.open.start)
  )[0];
}

function blockKindForTag(tag) {
  return tag.id;
}

function blockKindForOpenTag(openTag) {
  const nameMatch = openTag.match(/^<(p|h[1-6]|div)\b/i);
  if (!nameMatch) return "";
  const name = nameMatch[1].toLowerCase();
  if (name !== "p") return name;

  const alignMatch = openTag.match(/\balign\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const align = (alignMatch?.[1] || alignMatch?.[2] || alignMatch?.[3] || "").trim().toLowerCase();
  if (align === "center") return "c";
  if (align === "right") return "r";
  return "p";
}

function removeBlockOperation(fullText, selectionStart, selectionEnd, block) {
  const inner = fullText.slice(block.open.end, block.close.start);
  const selectsWholeBlock = selectionStart === block.open.start && selectionEnd === block.close.end;
  const relativeStart = selectsWholeBlock ? 0 : selectionStart - block.open.end;
  const relativeEnd = selectsWholeBlock ? inner.length : selectionEnd - block.open.end;
  return {
    start: block.open.start,
    end: block.close.end,
    text: inner,
    selectStart: relativeStart,
    selectEnd: relativeEnd
  };
}
function replaceBlockOperation(fullText, selectionStart, selectionEnd, tag, block) {
  const inner = fullText.slice(block.open.end, block.close.start);
  const selectsWholeBlock = selectionStart === block.open.start && selectionEnd === block.close.end;
  const relativeStart = selectsWholeBlock ? 0 : selectionStart - block.open.end;
  const relativeEnd = selectsWholeBlock ? inner.length : selectionEnd - block.open.end;
  return {
    start: block.open.start,
    end: block.close.end,
    text: tag.open + inner + tag.close,
    selectStart: tag.open.length + relativeStart,
    selectEnd: tag.open.length + relativeEnd
  };
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
    view.webview.onDidReceiveMessage(handleBarMessage, null, this.context.subscriptions);
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
}
function renderBar(webview) {
  const nonce = String(Date.now());
  const tagButtons = tags.map(tag => buttonHtml("insertTag", tag)).join("");
  const attrButtons = attrs.map(attr => buttonHtml("insertAttr", attr, "attr")).join("");
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
      overflow: hidden;
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
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
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

function deactivate() {}

module.exports = { activate, deactivate };