const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL, fileURLToPath } = require("node:url");
const manifest = require("../package.json");

test("extension activates, registers commands, and resolves a restored PDF custom editor", async () => {
  const registered = new Set();
  let provider;
  const disposable = { dispose() {} };
  const uri = value => ({
    scheme: value.split(":")[0],
    path: value.replace(/^file:\/\//, ""),
    fsPath: /^file:\/\/\/[a-z]:/i.test(value) ? fileURLToPath(value) : value.replace(/^file:\/\//, ""),
    toString() { return value; }
  });
  const vscode = {
    Uri: {
      parse: uri,
      joinPath(base, ...parts) { return uri(`${base.toString()}/${parts.join("/")}`); }
    },
    window: {
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor() { return disposable; },
      registerWebviewViewProvider() { return disposable; },
      registerCustomEditorProvider(viewType, value, options) {
        assert.equal(viewType, "mewReader.pdf");
        assert.equal(typeof value.openCustomDocument, "function");
        assert.equal(typeof value.resolveCustomEditor, "function");
        assert.equal(options.supportsMultipleEditorsPerDocument, false);
        provider = value;
        return disposable;
      },
      showErrorMessage() {}, showInformationMessage() {}
    },
    workspace: { onDidSaveTextDocument() { return disposable; } },
    commands: {
      registerCommand(id) { registered.add(id); return disposable; },
      executeCommand() { return Promise.resolve(); }
    }
  };
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    return request === "vscode" ? vscode : original.call(this, request, parent, isMain);
  };
  try {
    const extension = require("../extension.cjs");
    extension.activate({
      subscriptions: [],
      extensionUri: uri("file:///extension"),
      globalState: { get() { return {}; }, update() { return Promise.resolve(); } }
    });
  } finally {
    Module._load = original;
  }
  const contributed = manifest.contributes.commands.map(item => item.command);
  assert.deepEqual(contributed.filter(id => !registered.has(id)), []);
  assert.deepEqual(manifest.contributes.customEditors, [{
    viewType: "mewReader.pdf",
    displayName: "MEW Synchronized PDF",
    selector: [{ filenamePattern: "*.pdf" }],
    priority: "option"
  }]);

  let receiveMessage;
  const posted = [];
  const panel = {
    webview: {
      cspSource: "vscode-webview:",
      asWebviewUri(value) { return value; },
      onDidReceiveMessage(callback) { receiveMessage = callback; return disposable; },
      postMessage(message) { posted.push(message); return Promise.resolve(true); }
    },
    onDidDispose() { return disposable; },
    dispose() {}
  };
  const pdfUri = uri("file:///books/mew.pdf");
  const document = provider.openCustomDocument(pdfUri);
  provider.resolveCustomEditor(document, panel);
  receiveMessage({ type: "ready", document: {
    pdfUri: "file:///books/mew.pdf",
    fileName: "mew.pdf",
    pageLabel: "317"
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.title, "mew.pdf");
  assert.equal(posted.at(-1).type, "showPdf");
  assert.equal(posted.at(-1).pageLabel, "317");
  assert.match(posted.at(-1).url, /mew\.pdf$/);
  assert.equal(posted.at(-1).nativeData, true);

  const fixture = await fs.mkdtemp(path.join(tmpdir(), "mew-pdf-data-"));
  try {
    const file = path.join(fixture, "book.pdf");
    const bytes = Buffer.from("%PDF-binary-test\x00\xff");
    await fs.writeFile(file, bytes);
    provider.resolveCustomEditor(provider.openCustomDocument(uri(pathToFileURL(file).href)), panel);
    receiveMessage({ type: "pdfDataRequest", id: 41, path: "unauthorized.pdf" });
    for (let i = 0; i < 100 && !posted.some(m => m.id === 41); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const response = posted.find(m => m.id === 41);
    assert.equal(response.type, "pdfData");
    assert.ok(response.data instanceof Uint8Array);
    assert.deepEqual(Buffer.from(response.data), bytes, "reads only the editor-bound path");
    await fs.unlink(file);
    receiveMessage({ type: "pdfDataRequest", id: 42 });
    for (let i = 0; i < 100 && !posted.some(m => m.id === 42); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.match(posted.find(m => m.id === 42).error, /ENOENT/);
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(tmpdir()));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
