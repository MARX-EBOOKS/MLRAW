// Keep the actual PDF.js worker, but perform resource I/O in its owning frame.
// VS Code cannot reliably associate resource requests made by a blob worker with
// that frame. The resulting service-worker timeout is 30 seconds per request.
export async function createPdfWorker(pdfjs, config) {
  const controller = new AbortController();
  const urls = [];
  let worker, pdfWorker;
  const blob = (data, type) => {
    const url = URL.createObjectURL(new Blob([data], { type }));
    urls.push(url);
    return url;
  };
  const read = async url => {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`PDF resource HTTP ${response.status}: ${url}`);
    return response.arrayBuffer();
  };
  const dispose = () => {
    controller.abort();
    pdfWorker?.destroy();
    worker?.terminate();
    urls.forEach(url => URL.revokeObjectURL(url));
  };
  try {
    // ICC conversion uses synchronous XHR inside PDF.js. Give it a local blob
    // up front, so enabling fast resource loading does not disable color profiles.
    const [source, icc] = await Promise.all([read(config.worker), read(`${config.wasm}qcms_bg.wasm`)]);
    const iccUrl = blob(icc, "application/wasm");
    const roots = [config.cMap, config.fonts, config.wasm];
    const bootstrap = `(() => {
      const roots = ${JSON.stringify(roots)};
      const nativeFetch = globalThis.fetch;
      const requests = new Map();
      let id = 0;
      globalThis.fetch = (url, options) => {
        if (typeof url !== 'string' || !roots.some(root => url.startsWith(root))) return nativeFetch(url, options);
        return new Promise((resolve, reject) => {
          const requestId = ++id;
          requests.set(requestId, { resolve, reject });
          postMessage({ type: 'mewPdfResource', id: requestId, url });
        });
      };
      addEventListener('message', ({ data }) => {
        if (data?.type !== 'mewPdfResourceResult') return;
        const request = requests.get(data.id);
        if (!request) return;
        requests.delete(data.id);
        if (data.error) request.reject(new Error(data.error));
        else request.resolve(new Response(data.bytes));
      });
      const open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        return open.call(this, method, url === ${JSON.stringify(`${config.wasm}qcms_bg.wasm`)} ? ${JSON.stringify(iccUrl)} : url, ...args);
      };
    })();\n`;
    const workerUrl = blob(new Blob([bootstrap, source]), "text/javascript");
    worker = new Worker(workerUrl, { type: "module" });
    worker.addEventListener("message", async ({ data }) => {
      if (data?.type !== "mewPdfResource") return;
      try {
        if (typeof data.url !== "string" || !roots.some(root => data.url.startsWith(root))) throw new Error("Invalid PDF resource URL");
        const bytes = await read(data.url);
        if (!controller.signal.aborted) worker.postMessage({ type: "mewPdfResourceResult", id: data.id, bytes }, [bytes]);
      } catch (error) {
        if (!controller.signal.aborted) worker.postMessage({ type: "mewPdfResourceResult", id: data.id, error: error.message });
      }
    });
    pdfWorker = new pdfjs.PDFWorker({ port: worker });
    return { pdfWorker, worker, dispose };
  } catch (error) { dispose(); throw error; }
}
