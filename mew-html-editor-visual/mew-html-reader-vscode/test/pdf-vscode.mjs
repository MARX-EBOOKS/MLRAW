// Isolated VS Code integration benchmark. Does not install into the user's profile.
// node test/pdf-vscode.mjs <absolute PDF path>
import { _electron } from "playwright";
import { mkdtemp, readFile, writeFile, symlink, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = await mkdtemp(path.join(tmpdir(), "mew-pdf-vscode-"));
const dev = path.join(fixture, "extension");
await mkdir(dev);
for (const file of ["package.json", "reader-core.cjs", "reader-pdf.css", "pdf-source.mjs", "pdf-worker.mjs"]) await copyFile(path.join(root, file), path.join(dev, file));
for (const dir of ["vendor", "media"]) await symlink(path.join(root, dir), path.join(dev, dir), "junction");
let extension = await readFile(path.join(root, "extension.cjs"), "utf8");
extension = extension.replace('function activate(context) {', `function activate(context) {
  setTimeout(() => vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(${JSON.stringify(path.resolve(process.argv[2]))}), 'mewReader.pdf'), 800);`);
extension = extension.replace('pageLabel: "1"', 'pageLabel: "300"');
await writeFile(path.join(dev, "extension.cjs"), extension);
let script = await readFile(path.join(root, process.env.PDF_BASELINE ? "test/artifacts/reader-pdf-before.js" : "reader-pdf.js"), "utf8");
script = script.replace("const eventBus = new pdfview.EventBus();", `const eventBus = new pdfview.EventBus();
  window.__renders = [];
  eventBus.on('pagerendered', e => window.__renders.push({ page: e.pageNumber, ms: performance.now(), error: e.error?.message }));`);
script += "\nwindow.__reader = { get viewer() { return viewer; }, get worker() { return config.pdfWorker?.port; }, loadPdf, get pending() { return pending; } };";
script = script.replace('const vscode = acquireVsCodeApi();', 'window.__timings = { script: performance.now() }; const vscode = acquireVsCodeApi();')
  .replace('async function loadPdf(message) {', 'async function loadPdf(message) { window.__timings.load = performance.now();')
  .replace('loadingTask = config.pdfjs.getDocument({', 'window.__timings.source = performance.now(); loadingTask = config.pdfjs.getDocument({')
  .replace('const document = await loadingTask.promise;', 'const document = await loadingTask.promise; window.__timings.document = performance.now();')
  .replace('vscode.postMessage({ type: "ready", document: stored.document });', 'window.__timings.ready = performance.now(); vscode.postMessage({ type: "ready", document: stored.document });');
await writeFile(path.join(dev, "reader-pdf.js"), script);
await mkdir(path.join(fixture, "user", "User"), { recursive: true });
await writeFile(path.join(fixture, "user", "User", "settings.json"), JSON.stringify({
  "workbench.startupEditor": "none", "window.restoreWindows": "none", "update.mode": "none",
  "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off"
}));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: process.env.VSCODE_EXE || "D:\\Program Files\\Microsoft VS Code\\Code.exe", env,
  args: ["--no-sandbox", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust",
    `--user-data-dir=${path.join(fixture, 'user')}`, `--extensions-dir=${path.join(fixture, 'extensions')}`, `--extensionDevelopmentPath=${dev}`],
  timeout: 60000 });
try {
  const win = await app.firstWindow();
  win.on('console', message => { if (/fake worker|ICCBased|wasm|Worker|fetch/i.test(message.text())) console.log(message.type(), message.text()); });
  let frame;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    frame = win.frames().find(f => f.url().includes("vscode-webview") && !f.url().includes("fake.html"));
    // The HTML itself is in an inner iframe, under the webview preload frame.
    for (const candidate of win.frames()) {
      if (await candidate.evaluate(() => !!window.__reader).catch(() => false)) { frame = candidate; break; }
    }
    if (frame && await frame.evaluate(() => !!window.__reader).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(frame, "PDF webview frame opened");
  await frame.waitForFunction(() => {
    const v = window.__reader?.viewer;
    return v?.pdfDocument && document.querySelector("#pageNumber").value === "300" && window.__renders.some(e => e.page === v.currentPageNumber);
  }, null, { timeout: 60000 });
  const result = await frame.evaluate(() => {
    const v = window.__reader.viewer;
    return { pages: v.pagesCount, page: v.currentPageNumber, label: document.querySelector("#pageNumber").value,
      startupToTargetMs: Math.round(window.__renders.find(e => e.page === v.currentPageNumber).ms),
      loadedPages: v._pages.filter(p => p.pdfPage).length,
      realWorker: window.__reader.worker instanceof Worker,
      timings: window.__timings,
      slowResources: performance.getEntriesByType('resource').filter(r => r.duration > 500).map(r => ({ url: r.name, ms: Math.round(r.duration) })),
      errors: window.__renders.filter(e => e.error) };
  });
  assert.deepEqual(result.errors, []);
  if (!process.env.PDF_BASELINE) {
    assert.equal(result.realWorker, true);
    assert.ok(result.startupToTargetMs < 5000, `Target page took ${result.startupToTargetMs} ms`);
    assert.ok(result.loadedPages < 20);
  }
  console.log(JSON.stringify({ file: process.argv[2], mode: process.env.PDF_BASELINE ? "before" : "after", ...result, fixture }));
  await win.screenshot({ path: path.join(root, "test", "artifacts", `vscode-${path.basename(process.argv[2])}-${process.env.PDF_BASELINE ? 'before' : 'after'}.png`) });
  const start = Date.now();
  await frame.locator("#next").click();
  await frame.waitForFunction(n => window.__renders.some(e => e.page === n), result.page + 1);
  console.log(`Next page: ${Date.now() - start} ms`);
  await frame.evaluate(() => {
    const document = window.__reader.viewer.pdfDocument;
    window.__oldDocument = document;
    window.__reader.loadPdf({ ...window.__reader.pending, pageLabel: '300' });
  });
  await frame.waitForFunction(() => document.querySelector('#pageNumber').value === '300');
  assert.equal(await frame.evaluate(() => window.__reader.viewer.pdfDocument === window.__oldDocument), true);
  await frame.locator("#zoom").fill("100%"); await frame.locator("#zoom").press("Enter");
  await frame.waitForFunction(() => window.__reader.viewer.currentScale === 1);
  await frame.locator("#direction").click();
  await frame.waitForFunction(() => window.__reader.viewer.scrollMode === 1);
  await frame.locator('#settings').click();
  await frame.locator('#invert').check();
  assert.equal(await frame.locator('#invert').isChecked(), true);
  await frame.locator('#settingsDialog button[aria-label="关闭"]').click();
  await writeFile(path.join(root, 'test', 'artifacts', `vscode-${path.basename(process.argv[2])}-${process.env.PDF_BASELINE ? 'before' : 'after'}.json`), JSON.stringify(result, null, 2));
} finally { await app.close(); }
