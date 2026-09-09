// VS Code's resource bridge supports Range, but does not advertise the headers
// PDF.js uses for automatic range detection. Probe explicitly, retaining native
// webview URI permissions and remote-file support instead of copying whole PDFs.
export const RANGE_CHUNK_SIZE = 64 * 1024;

let nextRequestId = 0;
// For ordinary local books, one binary IPC transfer is faster than hundreds of
// service-worker round trips for scattered page dictionaries. PDF.js transfers
// the resulting typed array to its worker; no Base64 or JSON byte arrays.
export function requestPdfData(vscode, signal, target = globalThis.window) {
  return new Promise((resolve, reject) => {
    const id = ++nextRequestId;
    const cleanup = () => {
      target.removeEventListener("message", receive);
      signal.removeEventListener("abort", abort);
      clearTimeout(timeout);
    };
    const abort = () => { cleanup(); reject(new DOMException("PDF load cancelled", "AbortError")); };
    const receive = ({ data: message }) => {
      if (message?.type !== "pdfData" || message.id !== id) return;
      cleanup();
      if (message.error) reject(new Error(message.error));
      else resolve(message.data ? { data: message.data, disableAutoFetch: true } : null);
    };
    const timeout = setTimeout(() => { cleanup(); reject(new Error("读取 PDF 超时，请重新打开文件。")); }, 30000);
    target.addEventListener("message", receive);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) return abort();
    vscode.postMessage({ type: "pdfDataRequest", id });
  });
}

export async function openPdfSource(pdfjs, url, { signal, onError, fetch: fetcher = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const dispose = () => {
    signal?.removeEventListener("abort", abort);
    abort();
  };
  const request = (begin, end) => fetcher(url, {
    headers: { Range: `bytes=${begin}-${end - 1}` },
    signal: controller.signal
  });
  const readRange = async (response, begin, end, length) => {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get("Content-Range") || "");
    if (response.status !== 206 || !match || Number(match[1]) !== begin ||
        Number(match[2]) !== end - 1 || Number(match[3]) !== length) {
      await response.body?.cancel();
      throw new Error("PDF 分段响应无效，请关闭后重新打开文件。");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== end - begin) throw new Error("PDF 分段数据不完整。");
    return bytes;
  };
  try {
    const response = await request(0, RANGE_CHUNK_SIZE);
    // Providers without range support may return the full file. Consume that
    // response once, rather than retrying and downloading the same file twice.
    if (response.status === 200) {
      const data = new Uint8Array(await response.arrayBuffer());
      dispose();
      return { data, disableAutoFetch: true };
    }
    const total = Number(/^bytes \d+-\d+\/(\d+)$/i.exec(response.headers.get("Content-Range") || "")?.[1]);
    if (!Number.isSafeInteger(total) || total <= 0) {
      await response.body?.cancel();
      throw new Error(`无法读取 PDF 文件长度（HTTP ${response.status}）。`);
    }
    const initial = await readRange(response, 0, Math.min(total, RANGE_CHUNK_SIZE), total);
    const range = new pdfjs.PDFDataRangeTransport(total, initial, true);
    range.abort = dispose;
    range.requestDataRange = (begin, end) => {
      request(begin, end)
        .then(response => readRange(response, begin, end, total))
        .then(bytes => { if (!controller.signal.aborted) range.onDataRange(begin, bytes); })
        .catch(error => {
          if (controller.signal.aborted) return;
          dispose();
          onError?.(error);
        });
    };
    return { range, rangeChunkSize: RANGE_CHUNK_SIZE, disableStream: true, disableAutoFetch: true };
  } catch (error) {
    dispose();
    throw error;
  }
}
