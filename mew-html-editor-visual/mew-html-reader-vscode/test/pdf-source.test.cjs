const test = require("node:test");
const assert = require("node:assert/strict");

class Transport {
  constructor(length, initialData) { Object.assign(this, { length, initialData }); }
  onDataRange(begin, bytes) { this.received = { begin, bytes }; }
}
const pdfjs = { PDFDataRangeTransport: Transport };
const tick = () => new Promise(resolve => setImmediate(resolve));
const partial = (bytes, begin, total) => new Response(bytes, {
  status: 206, headers: { "Content-Range": `bytes ${begin}-${begin + bytes.length - 1}/${total}` }
});

test("unadvertised range support reads only requested bytes, including EOF", async () => {
  const { openPdfSource, RANGE_CHUNK_SIZE: size } = await import("../pdf-source.mjs");
  const total = 100 * 1024 * 1024 + 17;
  const requests = [];
  const source = await openPdfSource(pdfjs, "test.pdf", { fetch: async (_, options) => {
    const [begin, end] = options.headers.Range.match(/\d+/g).map(Number);
    requests.push({ begin, end });
    return partial(new Uint8Array(Math.min(total, end + 1) - begin).fill(begin ? 2 : 1), begin, total);
  } });
  assert.equal(source.range.length, total);
  assert.equal(source.range.initialData.length, size);
  assert.equal(source.disableAutoFetch, true);
  assert.equal(source.disableStream, true);
  assert.equal(requests.length, 1);
  source.range.requestDataRange(total - 17, total);
  await tick();
  assert.deepEqual(source.range.received, { begin: total - 17, bytes: new Uint8Array(17).fill(2) });
  assert.equal(requests.length, 2);
  source.range.abort();
});

test("small PDF and non-range provider use their first response exactly once", async () => {
  const { openPdfSource } = await import("../pdf-source.mjs");
  for (const supportsRange of [true, false]) {
    let calls = 0;
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const source = await openPdfSource(pdfjs, "test.pdf", { fetch: async () => {
      calls++;
      return supportsRange ? partial(bytes, 0, bytes.length) : new Response(bytes);
    } });
    assert.deepEqual(source.range?.initialData || source.data, bytes);
    assert.equal(calls, 1);
    source.range?.abort();
  }
});

test("malformed or truncated ranges fail rather than hanging or corrupting the PDF", async () => {
  const { openPdfSource } = await import("../pdf-source.mjs");
  await assert.rejects(openPdfSource(pdfjs, "test.pdf", { fetch: async () => new Response("missing", { status: 404 }) }), /HTTP 404/);
  await assert.rejects(openPdfSource(pdfjs, "test.pdf", { fetch: async () => new Response(new Uint8Array(3), {
    status: 206, headers: { "Content-Range": "bytes 0-3/4" }
  }) }), /不完整/);
  let calls = 0, failure;
  const source = await openPdfSource(pdfjs, "test.pdf", { onError: error => { failure = error; }, fetch: async () => {
    return ++calls === 1 ? partial(new Uint8Array(4), 0, 4) : new Response("changed");
  } });
  source.range.requestDataRange(0, 4);
  await tick();
  assert.match(failure.message, /分段响应无效/);
});

test("switching documents aborts outstanding reads without delivering stale data", async () => {
  const { openPdfSource } = await import("../pdf-source.mjs");
  const controller = new AbortController();
  let requestSignal, finish, failures = 0, calls = 0;
  const source = await openPdfSource(pdfjs, "test.pdf", { signal: controller.signal,
    onError: () => { failures++; }, fetch: async (_, options) => {
      if (++calls === 1) return partial(new Uint8Array(4), 0, 4);
      requestSignal = options.signal;
      return new Promise(resolve => { finish = resolve; });
    }
  });
  source.range.requestDataRange(0, 4);
  controller.abort();
  assert.equal(requestSignal.aborted, true);
  finish(partial(new Uint8Array(4), 0, 4));
  await tick();
  assert.equal(source.range.received, undefined);
  assert.equal(failures, 0);
});

test("binary IPC correlates replies, preserves typed bytes, and supports cancellation", async () => {
  const { requestPdfData } = await import("../pdf-source.mjs");
  const target = new EventTarget();
  const messages = [];
  const vscode = { postMessage: message => messages.push(message) };
  const controller = new AbortController();
  const pending = requestPdfData(vscode, controller.signal, target);
  const data = new Uint8Array([1, 2, 3]);
  target.dispatchEvent(new MessageEvent("message", { data: { type: "pdfData", id: -1, error: "stale" } }));
  target.dispatchEvent(new MessageEvent("message", { data: { type: "pdfData", id: messages[0].id, data } }));
  assert.deepEqual(await pending, { data, disableAutoFetch: true });
  const cancelled = requestPdfData(vscode, controller.signal, target);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  const fallback = requestPdfData(vscode, new AbortController().signal, target);
  target.dispatchEvent(new MessageEvent("message", { data: { type: "pdfData", id: messages.at(-1).id, data: null } }));
  assert.equal(await fallback, null);
});
