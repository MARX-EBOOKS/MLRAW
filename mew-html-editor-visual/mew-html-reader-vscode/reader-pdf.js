import { openPdfSource, requestPdfData } from "./pdf-source.mjs";
import { createPdfWorker } from "./pdf-worker.mjs";

const vscode = acquireVsCodeApi();
const config = JSON.parse(document.querySelector("#reader-config").dataset.config);
const DEFAULTS = { scale: "page-width", horizontal: false, brightness: 100, paper: "#ffffff", ink: "#000000", invert: false };
const stored = { ...(config.displaySettings || {}), ...(vscode.getState() || {}) };
const stage = document.querySelector("#stage");
const status = document.querySelector("#status");
const title = document.querySelector("#title");
const zoom = document.querySelector("#zoom");
const pageNumber = document.querySelector("#pageNumber");
const pageCount = document.querySelector("#pageCount");
let viewer, linkService, labels, loadingTask, scrollMode, currentUrl = "", pending, syncing = false;
let documentRevision = 0, labelsReady = Promise.resolve(), sourceController, initializing = false;
let state = normalizeState(stored);

function normalizeState(value) {
  const color = (input, fallback) => /^#[0-9a-f]{6}$/i.test(input || "") ? input : fallback;
  return {
    scale: typeof value.scale === "string" ? value.scale : DEFAULTS.scale,
    horizontal: Boolean(value.horizontal),
    brightness: Math.max(50, Math.min(160, Number(value.brightness) || DEFAULTS.brightness)),
    paper: color(value.paper, DEFAULTS.paper),
    ink: color(value.ink, DEFAULTS.ink),
    invert: Boolean(value.invert)
  };
}

function saveState(changes) {
  state = normalizeState({ ...state, ...changes });
  persistState();
  vscode.postMessage({
    type: "pdfDisplaySettings",
    settings: {
      brightness: state.brightness,
      paper: state.paper,
      ink: state.ink,
      invert: state.invert
    }
  });
}

function persistState() {
  vscode.setState({ ...state, document: pending ? {
    htmlUri: pending.htmlUri,
    pdfUri: pending.pdfUri,
    fileName: pending.fileName,
    pageLabel: pending.pageLabel
  } : undefined });
}

function showStatus(text) { status.textContent = text; status.hidden = !text; }
function matchingPage(label) {
  const matches = labels?.map((value, index) => String(value) === String(label) ? index + 1 : 0).filter(Boolean) || [];
  const current = viewer?.currentPageNumber || matches[0];
  return matches.reduce((best, item) => Math.abs(item - current) < Math.abs(best - current) ? item : best, matches[0]);
}
function showPending() {
  const page = matchingPage(pending?.pageLabel);
  if (!page) return;
  // Setting currentPageNumber to the page that is already current makes PDF.js
  // scroll that page back into view, losing the reader's offset within the page.
  if (page === viewer.currentPageNumber) return showPage(page);
  syncing = true;
  viewer.currentPageNumber = page;
  showPage(page);
  queueMicrotask(() => { syncing = false; });
}
// Keep the control in PDF.js scale units: 1 is 100%. PDF.js applies its own
// PDF-point-to-CSS-pixel conversion internally; that conversion is not zoom.
function scalePercent(scale) { return Math.round(scale * 100); }
function showScale() { zoom.value = viewer?.currentScale ? `${scalePercent(viewer.currentScale)}%` : "页宽"; }
function showPage(number = viewer?.currentPageNumber || 1) {
  const count = viewer?.pagesCount || 0;
  pageNumber.value = String(labels?.[number - 1] ?? number);
  pageCount.value = String(count);
  document.querySelector("#previous").disabled = number <= 1;
  document.querySelector("#next").disabled = !count || number >= count;
}

function channels(hex) {
  return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
}

function applyDisplaySettings() {
  const paper = channels(state.paper), ink = channels(state.ink);
  ["filterR", "filterG", "filterB"].forEach((id, index) => document.querySelector(`#${id}`).setAttribute("tableValues", `${ink[index]} ${paper[index]}`));
  const filters = [];
  if (state.paper !== DEFAULTS.paper || state.ink !== DEFAULTS.ink) filters.push("url(#scanColorFilter)");
  if (state.brightness !== DEFAULTS.brightness) filters.push(`brightness(${state.brightness}%)`);
  if (state.invert) filters.push("invert(1)");
  stage.style.setProperty("--paper", state.paper);
  stage.style.setProperty("--scan-filter", filters.join(" ") || "none");
  document.querySelector("#brightness").value = String(state.brightness);
  document.querySelector("#brightnessValue").value = `${state.brightness}%`;
  document.querySelector("#paper").value = state.paper;
  document.querySelector("#ink").value = state.ink;
  document.querySelector("#invert").checked = state.invert;
}

function applyDirection() {
  const direction = document.querySelector("#direction");
  direction.textContent = state.horizontal ? "上下翻页" : "左右翻页";
  direction.setAttribute("aria-pressed", String(state.horizontal));
  if (viewer && scrollMode) viewer.scrollMode = state.horizontal ? scrollMode.HORIZONTAL : scrollMode.VERTICAL;
}

function commitPage() {
  if (!viewer?.pdfDocument) return showPage();
  const value = pageNumber.value.trim();
  // Match PDF.js' normal viewer: an exact Page Label wins and duplicate labels
  // resolve to their first occurrence; otherwise a number is a physical page.
  const labelIndex = labels?.findIndex(label => String(label) === value) ?? -1;
  const numericPage = Number(value);
  const target = labelIndex >= 0
    ? labelIndex + 1
    : Math.max(1, Math.min(viewer.pagesCount, Math.round(numericPage)));
  if (!Number.isFinite(target)) return showPage();
  viewer.currentPageNumber = target;
  showPage(target);
  pageNumber.select();
}

async function loadPdf(message) {
  const preservePosition = message.url === currentUrl &&
    Boolean(message.htmlUri) && message.htmlUri === pending?.htmlUri;
  pending = message;
  persistState();
  title.textContent = message.fileName || "MEW PDF";
  title.title = title.textContent;
  // HTML navigation can resend the same volume while it is still opening.
  // Keep the existing load and use the latest pending label when layout is ready.
  if (message.url === currentUrl) {
    // Returning between an HTML editor and a PDF hosted in another VS Code
    // window re-sends the same converted HTML. Do not let that refocus pull a
    // multi-page/gapped PDF back to the HTML file's first mapped page. A truly
    // different HTML file still synchronizes normally within the same PDF.
    if (!preservePosition && !initializing && viewer?.pdfDocument) showPending();
    return;
  }
  const revision = ++documentRevision;
  initializing = true;
  sourceController?.abort();
  const controller = sourceController = new AbortController();
  currentUrl = message.url; labels = null; showStatus("正在载入 PDF…"); showPage(1);
  viewer.setDocument(null); linkService.setDocument(null);
  const fail = error => {
    if (revision !== documentRevision || controller.signal.aborted) return;
    controller.abort();
    currentUrl = "";
    initializing = false;
    showStatus(`PDF 载入失败：${error.message}`);
    loadingTask?.destroy().catch(() => {});
  };
  try {
    await loadingTask?.destroy();
    if (revision !== documentRevision) return;
    const source = (message.nativeData && await requestPdfData(vscode, controller.signal)) ||
      await openPdfSource(config.pdfjs, message.url, { signal: controller.signal, onError: fail });
    if (revision !== documentRevision) { source.range?.abort(); return; }
    loadingTask = config.pdfjs.getDocument({
      ...source,
      worker: config.pdfWorker,
      cMapUrl: config.cMap,
      cMapPacked: true,
      standardFontDataUrl: config.fonts,
      wasmUrl: config.wasm,
      useWorkerFetch: true,
      docBaseUrl: message.url
    });
    const document = await loadingTask.promise;
    if (revision !== documentRevision) return;
    // Page-label metadata and PDFViewer's first-page/layout work are independent.
    // Starting both now removes a serial wait from every first open.
    labelsReady = document.getPageLabels().catch(() => null).then(value => {
      if (revision !== documentRevision) return;
      labels = value || Array.from({ length: document.numPages }, (_, index) => String(index + 1));
      viewer.setPageLabels(labels);
    });
    viewer.setDocument(document); linkService.setDocument(document);
  } catch (error) {
    fail(error);
  }
}

async function init() {
  const pdfjs = await import(config.core);
  globalThis.pdfjsLib = pdfjs;
  const [runtime, pdfview] = await Promise.all([createPdfWorker(pdfjs, config), import(config.viewer)]);
  const { worker } = runtime;
  config.pdfWorker = runtime.pdfWorker;
  worker.addEventListener("error", event => showStatus(`PDF Worker 初始化失败：${event.message || "无法启动"}`));
  window.addEventListener("pagehide", () => {
    sourceController?.abort();
    runtime.dispose();
  }, { once: true });
  const eventBus = new pdfview.EventBus();
  linkService = new pdfview.PDFLinkService({ eventBus });
  viewer = new pdfview.PDFViewer({ container: stage, viewer: document.querySelector("#viewer"), eventBus, linkService, imageResourcesPath: config.images });
  linkService.setViewer(viewer); config.pdfjs = pdfjs; scrollMode = pdfview.ScrollMode;
  eventBus.on("pagesinit", async () => {
    const revision = documentRevision;
    await labelsReady;
    if (revision !== documentRevision || !viewer.pdfDocument) return;
    viewer.currentScaleValue = state.scale;
    applyDirection();
    showPending();
    showPage();
    queueMicrotask(() => { if (revision === documentRevision) initializing = false; });
  });
  eventBus.on("pagerendered", ({ pageNumber: number, error }) => {
    if (number === viewer.currentPageNumber) showStatus(error ? `PDF 页面渲染失败：${error.message}` : "");
  });
  eventBus.on("pagechanging", ({ pageNumber: number, pageLabel }) => { showPage(number); if (!syncing && !initializing) vscode.postMessage({ type: "pdfPageChange", pageNumber: number, pageLabel }); });
  eventBus.on("scalechanging", ({ scale, presetValue }) => { saveState({ scale: presetValue || String(scale) }); zoom.value = `${scalePercent(scale)}%`; });

  document.querySelector("#minus").onclick = () => viewer.decreaseScale();
  document.querySelector("#plus").onclick = () => viewer.increaseScale();
  zoom.onfocus = () => zoom.select();
  zoom.onkeydown = event => {
    if (event.key === "Enter") {
      const value = zoom.value.trim();
      const percent = Number(value.replace(/%$/, ""));
      if (/^(页宽|page-width|auto)$/i.test(value)) viewer.currentScaleValue = "page-width";
      else if (Number.isFinite(percent)) viewer.currentScaleValue = String(Math.max(25, Math.min(1000, percent)) / 100);
      else showScale();
      zoom.select();
    } else if (event.key === "Escape") { showScale(); zoom.blur(); }
  };

  pageNumber.onfocus = () => pageNumber.select();
  pageNumber.onchange = commitPage;
  pageNumber.onkeydown = event => {
    if (event.key === "Enter") commitPage();
    else if (event.key === "Escape") { showPage(); pageNumber.blur(); }
  };
  document.querySelector("#previous").onclick = () => { if (viewer.currentPageNumber > 1) viewer.currentPageNumber -= 1; };
  document.querySelector("#next").onclick = () => { if (viewer.currentPageNumber < viewer.pagesCount) viewer.currentPageNumber += 1; };
  document.querySelector("#direction").onclick = () => { saveState({ horizontal: !state.horizontal }); applyDirection(); };
  document.querySelector("#settings").onclick = () => document.querySelector("#settingsDialog").showModal();
  document.querySelector("#brightness").oninput = event => { saveState({ brightness: event.target.value }); applyDisplaySettings(); };
  document.querySelector("#paper").oninput = event => { saveState({ paper: event.target.value }); applyDisplaySettings(); };
  document.querySelector("#ink").oninput = event => { saveState({ ink: event.target.value }); applyDisplaySettings(); };
  document.querySelector("#invert").onchange = event => { saveState({ invert: event.target.checked }); applyDisplaySettings(); };
  document.querySelector("#reset").onclick = () => { saveState(DEFAULTS); applyDisplaySettings(); applyDirection(); if (viewer?.pdfDocument) viewer.currentScaleValue = DEFAULTS.scale; };

  applyDisplaySettings(); applyDirection(); showPage();
  window.addEventListener("message", event => { if (event.data?.type === "showPdf") loadPdf(event.data); });
  vscode.postMessage({ type: "ready", document: stored.document });
}
init().catch(error => showStatus(`PDF.js 初始化失败：${error.message}`));
