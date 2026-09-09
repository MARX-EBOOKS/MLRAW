// Real PDF.js/worker/canvas benchmark with the installed VS Code bridge's header
// behavior (206 Content-Range; no Content-Length or Accept-Ranges on full GET).
// node test/pdf-browser.mjs [absolute PDF paths...]
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = path.join(root, "test", "artifacts");
await mkdir(artifacts, { recursive: true });
const files = process.argv.slice(2);
assert.ok(files.length, "Pass at least one real PDF path");
const extension = await readFile(path.join(root, "extension.cjs"), "utf8");
const stub = { Uri: { joinPath: (base, ...parts) => `${base}/${parts.join("/")}` } };
const sandbox = { require: name => name === "vscode" ? stub : createRequire(path.join(root, "extension.cjs"))(name), exports: {}, module: { exports: {} }, console };
vm.createContext(sandbox);
vm.runInContext(`${extension}\nexports.pdfHtml = ReaderController.prototype.pdfHtml;`, sandbox);
const html = sandbox.exports.pdfHtml.call({ context: { extensionUri: "", globalState: { get: () => ({}) } } }, {
  cspSource: "'self'", asWebviewUri: value => value
});
let activeFile, bytesRead = 0, requests = [];
const mime = { ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); return;
    }
    if (url.pathname === "/book.pdf") {
      const info = await stat(activeFile);
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
      const begin = range ? Number(range[1]) : 0;
      const end = range ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      requests.push({ begin, end, range: Boolean(range) });
      res.writeHead(range ? 206 : 200, {
        "Content-Type": "application/pdf",
        ...(range ? { "Content-Range": `bytes ${begin}-${end}/${info.size}` } : {})
      });
      const stream = createReadStream(activeFile, { start: begin, end });
      stream.on("data", data => { bytesRead += data.length; });
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res); return;
    }
    let source = await readFile(path.join(root, decodeURIComponent(url.pathname)));
    if (url.pathname === "/reader-pdf.js") {
      if (process.env.PDF_BASELINE) source = await readFile(path.join(artifacts, "reader-pdf-before.js"));
      source = source.toString().replace("const eventBus = new pdfview.EventBus();", `const eventBus = new pdfview.EventBus();
        window.__renders = [];
        eventBus.on('pagerendered', e => window.__renders.push({ page: e.pageNumber, ms: performance.now(), error: e.error?.message }));`);
      source += "\nwindow.__reader = { get viewer() { return viewer; }, loadPdf, get pending() { return pending; } };";
    }
    res.writeHead(200, { "Content-Type": mime[path.extname(url.pathname)] || "application/octet-stream" }); res.end(source);
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];
try {
  for (const file of files) {
    activeFile = path.resolve(file); bytesRead = 0; requests = [];
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__messages = [];
      window.acquireVsCodeApi = () => ({ getState: () => null, setState() {}, postMessage: message => window.__messages.push(message) });
    });
    await page.goto(base);
    await page.waitForFunction(() => window.__messages.some(m => m.type === "ready"));
    await page.evaluate(url => {
      window.__start = performance.now();
      window.postMessage({ type: "showPdf", url, htmlUri: "file:///pages/300.html", fileName: "Benchmark PDF", pageLabel: "300" });
    }, `${base}/book.pdf`);
    await page.waitForFunction(() => {
      const v = window.__reader.viewer;
      return v?.pdfDocument && document.querySelector("#pageNumber").value === "300" && window.__renders.some(e => e.page === v.currentPageNumber);
    }, null, { timeout: 120000 });
    const measured = await page.evaluate(() => {
      const v = window.__reader.viewer;
      return { pages: v.pagesCount, physicalPage: v.currentPageNumber,
        targetMs: Math.round(window.__renders.find(e => e.page === v.currentPageNumber).ms - window.__start),
        startupToTargetMs: Math.round(window.__renders.find(e => e.page === v.currentPageNumber).ms),
        loadedPages: v._pages.filter(p => p.pdfPage).length,
        renderErrors: window.__renders.filter(e => e.error) };
    });
    const firstBytes = bytesRead;
    console.log(JSON.stringify({ measured, firstBytes, firstRequests: requests.slice(0, 20), requestCount: requests.length }));
    assert.deepEqual(measured.renderErrors, []);
    if (!process.env.PDF_BASELINE) {
      assert.ok(requests.every(r => r.range), "no full PDF download");
      assert.ok(measured.loadedPages < 20, "no whole-book page parsing");
    }
    await page.screenshot({ path: path.join(artifacts, `${path.basename(file)}${process.env.PDF_BASELINE ? '-before' : '-after'}.png`) });
    await page.locator("#next").click();
    await page.waitForFunction(n => window.__renders.some(e => e.page === n), measured.physicalPage + 1);
    await page.evaluate(url => window.__reader.loadPdf({
      url, htmlUri: "file:///pages/300.html", fileName: "Benchmark PDF", pageLabel: "300"
    }), `${base}/book.pdf`);
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window.__reader.viewer.currentPageNumber), measured.physicalPage + 1,
      "returning to a separately hosted PDF preserves later progress for the same HTML");
    await page.evaluate(url => window.__reader.loadPdf({
      url, htmlUri: "file:///pages/other.html", fileName: "Benchmark PDF", pageLabel: "300"
    }), `${base}/book.pdf`);
    await page.waitForFunction(n => window.__reader.viewer.currentPageNumber === n, measured.physicalPage);
    await page.locator("#next").click();
    await page.waitForFunction(n => window.__reader.viewer.currentPageNumber === n, measured.physicalPage + 1);
    await page.locator("#previous").click();
    await page.waitForFunction(n => window.__reader.viewer.currentPageNumber === n, measured.physicalPage);
    await page.locator("#zoom").fill("100%"); await page.locator("#zoom").press("Enter");
    await page.waitForFunction(() => window.__reader.viewer.currentScale === 1);
    await page.locator("#direction").click();
    await page.waitForFunction(() => window.__reader.viewer.scrollMode === 1);
    await page.locator("#direction").click();
    assert.deepEqual(errors, []);
    const result = { file: path.basename(file), mode: process.env.PDF_BASELINE ? "before" : "after", size: (await stat(file)).size,
      ...measured, firstBytes, requestCount: requests.length };
    results.push(result); console.log(JSON.stringify(result));
    await context.close();
  }
  await writeFile(path.join(artifacts, `benchmark-${process.env.PDF_BASELINE ? 'before' : 'after'}.json`), JSON.stringify(results, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
