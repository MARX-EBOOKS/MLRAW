const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("PDF.js viewer container and viewer are div elements", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "extension.cjs"), "utf8");
  assert.match(source, /<div id="stage"><div id="viewer" class="pdfViewer"><\/div><\/div>/);
  assert.doesNotMatch(source, /<main id="stage">/);
});

test("PDF header exposes compact navigation and display controls", () => {
  const root = path.join(__dirname, "..");
  const extension = fs.readFileSync(path.join(root, "extension.cjs"), "utf8");
  const script = fs.readFileSync(path.join(root, "reader-pdf.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "reader-pdf.css"), "utf8");

  for (const id of ["direction", "settings", "previous", "pageNumber", "pageCount", "next", "settingsDialog", "paper"]) {
    assert.match(extension, new RegExp(`id="${id}"`));
  }
  assert.match(extension, /type: "showPdf"/);
  assert.match(extension, /fileName: path\.basename/);
  assert.doesNotMatch(extension, /type: "showPdf", title:/);
  assert.match(script, /scrollMode\.HORIZONTAL/);
  assert.match(script, /viewer\.currentPageNumber/);
  assert.match(extension, /id="pageNumber" type="text"/);
  assert.match(script, /labels\?\.\[number - 1\] \?\? number/);
  assert.match(script, /labels\?\.findIndex/);
  assert.match(script, /if \(page === viewer\.currentPageNumber\) return showPage\(page\)/);
  assert.match(extension, /retainContextWhenHidden: true/);
  assert.match(extension, /mewReader\.pdfDisplaySettings\.v1/);
  assert.match(extension, /globalState\.update\(PDF_DISPLAY_SETTINGS_KEY/);
  assert.match(script, /config\.displaySettings/);
  assert.match(script, /type: "pdfDisplaySettings"/);
  assert.match(script, /openPdfSource\(config\.pdfjs, message\.url/);
  assert.match(script, /docBaseUrl: message\.url/);
  assert.match(extension, /registerCustomEditorProvider\(PDF_PANEL_VIEW_TYPE, reader/);
  assert.match(extension, /openCustomDocument\(uri\)/);
  assert.match(extension, /resolveCustomEditor\(document, panel\)/);
  assert.match(extension, /executeCommand\("vscode\.openWith", current\.volume\.pdfUri, PDF_PANEL_VIEW_TYPE/);
  assert.match(script, /vscode\.setState\(\{ \.\.\.state, document:/);
  assert.match(extension, /htmlUri: this\.current\.uri\.toString\(true\)/);
  assert.match(extension, /const known = this\.knownPage\(uri\)/);
  assert.match(script, /labelsReady = document\.getPageLabels\(\)\.catch\(\(\) => null\)\.then/);
  assert.match(script, /viewer\.setDocument\(document\); linkService\.setDocument\(document\)/);
  assert.match(script, /--scan-filter/);
  assert.match(styles, /#tools[^}]*height:34px/);
  assert.match(styles, /#stage[^}]*inset:34px 0 0/);
});

test("configured page navigation leaves dirty state to VS Code", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "extension.cjs"), "utf8");
  assert.doesNotMatch(source, /document\.save\(\)/);
  assert.doesNotMatch(source, /pendingPdfPage|onDidSaveTextDocument/);
});

test("returning to a PDF in another window preserves later progress for the same HTML", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "reader-pdf.js"), "utf8");
  assert.match(source, /const preservePosition = message\.url === currentUrl/);
  assert.match(source, /Boolean\(message\.htmlUri\) && message\.htmlUri === pending\?\.htmlUri/);
  assert.match(source, /if \(!preservePosition && !initializing && viewer\?\.pdfDocument\) showPending\(\)/);
});
