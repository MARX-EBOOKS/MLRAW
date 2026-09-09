import http from "node:http";
import { createReadStream, existsSync, watch } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const MONACO = existsSync(path.join(HERE, "monaco", "min", "vs", "loader.js"))
  ? path.join(HERE, "monaco") : path.join(HERE, "node_modules", "monaco-editor");
const SETTINGS_FILE = path.join(HERE, "reader.settings.json");
const CONFIG_FILE = path.resolve(valueOf(["-c", "--config"]) || process.env.CONFIG || path.join(HERE, "reader.config.mjs"));
const PORT = Number(valueOf(["-p", "--port"]) || process.env.PORT || 49100);
const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".pdf": "application/pdf", ".wasm": "application/wasm",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"
};
let library;
const changeClients = new Set();
const changeTimers = new Map();

function valueOf(names) {
  const args = process.argv.slice(2);
  for (const name of names) {
    const exact = args.indexOf(name);
    if (exact >= 0) return args[exact + 1];
    const equal = args.find((arg) => arg.startsWith(`${name}=`));
    if (equal) return equal.slice(name.length + 1);
  }
  return "";
}

function reply(res, status, value, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(Buffer.isBuffer(value) || typeof value === "string" ? value : JSON.stringify(value));
}

async function jsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function readerSettings(value = {}) {
  const color = (input, fallback) => /^#[0-9a-f]{6}$/i.test(String(input)) ? String(input).toLowerCase() : fallback;
  return {
    brightness: Math.max(50, Math.min(160, Number(value.brightness) || 100)),
    paper: color(value.paper, "#ffffff"), ink: color(value.ink, "#000000"),
    invert: Boolean(value.invert), horizontal: Boolean(value.horizontal),
    scale: typeof value.scale === "string" && value.scale.length <= 32 ? value.scale : "page-width"
  };
}

async function loadReaderSettings() {
  try { return readerSettings(JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8"))); }
  catch { return readerSettings(); }
}

function resolveResource(raw, base) {
  const value = String(raw || ".");
  if (/^https?:\/\//i.test(value)) return { kind: "url", path: new URL(value).href.replace(/\/$/, "") };
  if (/^file:\/\//i.test(value)) return { kind: "file", path: path.resolve(fileURLToPath(value)) };
  return { kind: "file", path: path.resolve(base, value) };
}

function formatPattern(pattern, page, volume) {
  return String(pattern)
    .replace(/\{volume(?::(\d+))?\}/g, (_, width) => String(volume).padStart(Number(width || 0), "0"))
    .replace(/\{page(?::(\d+))?\}/g, (_, width) => String(page).padStart(Number(width || 0), "0"));
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function replyFile(req, res, location, type) {
  const stat = await fs.stat(location);
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!range) {
    res.writeHead(200, {
      "content-type": type,
      "content-length": stat.size,
      "accept-ranges": "bytes",
      "cache-control": "no-store"
    });
    if (req.method === "HEAD") return res.end();
    return createReadStream(location).pipe(res);
  }
  let start = range[1] ? Number(range[1]) : 0;
  let end = range[2] ? Number(range[2]) : stat.size - 1;
  if (!range[1] && range[2]) start = Math.max(0, stat.size - Number(range[2]));
  end = Math.min(end, stat.size - 1);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end) {
    res.writeHead(416, { "content-range": `bytes */${stat.size}` });
    return res.end();
  }
  res.writeHead(206, {
    "content-type": type,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${stat.size}`,
    "accept-ranges": "bytes",
    "cache-control": "no-store"
  });
  if (req.method === "HEAD") return res.end();
  return createReadStream(location, { start, end }).pipe(res);
}

function pageFromName(name, volume) {
  const escaped = String(volume).padStart(2, "0");
  const regular = name.match(new RegExp(`^ME${escaped}-(\\d+)\\.html?$`, "i"));
  if (regular) return Number(regular[1]);
  if (Number(volume) >= 261 && Number(volume) <= 263) {
    const split = name.match(new RegExp(`^ME26-${Number(volume) - 260}(\\d{3})\\.html?$`, "i"));
    if (split) return Number(split[1]);
  }
  return null;
}

async function loadLibrary() {
  const imported = await import(`${pathToFileURL(CONFIG_FILE).href}?t=${Date.now()}`);
  const config = imported.default || imported;
  const base = path.dirname(CONFIG_FILE);
  let htmlRoot = resolveResource(config.htmlRoot, base);
  const pdfRoot = resolveResource(config.pdfRoot || "../马恩全集德文", base);
  let editorRoot = config.editorRoot ? resolveResource(config.editorRoot, base) : htmlRoot;
  if (htmlRoot.kind === "file" && !(await exists(htmlRoot.path)) && config.htmlRoot === "./MEWB") {
    htmlRoot = resolveResource("../MEWB", base);
    if (!config.editorRoot) editorRoot = htmlRoot;
  }
  const volumeIds = new Set([
    ...Object.keys(config.inhalt || {}),
    ...(config.volumes || []).map((volume) => String(volume.id))
  ]);
  const volumes = [];

  for (const id of [...volumeIds].sort((a, b) => Number(a) - Number(b))) {
    const override = (config.volumes || []).find((volume) => String(volume.id) === id) || {};
    const pageDir = resolveResource(override.pages?.directory || `${htmlRoot.path}/${id}`, base);
    let pages = (override.pages?.list || []).map(Number);
    if (!pages.length && pageDir.kind === "file" && await exists(pageDir.path)) {
      const names = await fs.readdir(pageDir.path);
      pages = names.map((name) => pageFromName(name, id)).filter(Number.isFinite);
    }
    pages = [...new Set(pages)].sort((a, b) => a - b);
    if (!pages.length) continue;

    const toc = (override.toc || config.inhalt?.[id] || []).map((entry) => Array.isArray(entry)
      ? {
          title: String(entry[0]).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim(),
          level: Number(String(entry[0]).match(/^\s*<h([1-6])/i)?.[1] || 1),
          page: Number(entry[1])
        }
      : { title: entry.title, level: Number(entry.level || 1), page: Number(entry.page) }
    ).filter((entry) => entry.title && Number.isFinite(entry.page));
    const pdfName = override.pdf?.file || formatPattern(config.pdfPattern || "mew_band{volume:02}.pdf", 0, id);
    const pdf = override.pdf?.url
      ? resolveResource(override.pdf.url, base)
      : (pdfRoot.kind === "url"
        ? { kind: "url", path: `${pdfRoot.path}/${pdfName}` }
        : { kind: "file", path: path.resolve(pdfRoot.path, pdfName) });
    volumes.push({
      id, title: override.title || `马克思恩格斯全集 第${id}卷`,
      shortTitle: override.shortTitle || `第${id}卷`, pages, toc, pageDir,
      pagePattern: override.pages?.pattern || "",
      pdf
    });
  }
  library = { config, volumes, editorRoot: editorRoot.kind === "file" && await exists(editorRoot.path) ? editorRoot.path : null };
}

function getVolume(id) {
  const volume = library.volumes.find((item) => item.id === String(id));
  if (!volume) throw new Error(`找不到卷册 ${id}`);
  return volume;
}

function getPage(volume, raw) {
  const page = Number(raw);
  if (!volume.pages.includes(page)) throw new Error(`第 ${raw} 页不存在`);
  return page;
}

function pageName(volume, page) {
  if (volume.pagePattern) return formatPattern(volume.pagePattern, page, volume.id);
  if (Number(volume.id) >= 261 && Number(volume.id) <= 263) {
    return `ME26-${Number(volume.id) - 260}${String(page).padStart(3, "0")}.html`;
  }
  return `ME${String(volume.id).padStart(2, "0")}-${String(page).padStart(3, "0")}.html`;
}

function pageLocation(volume, page) {
  const name = pageName(volume, page);
  return volume.pageDir.kind === "url" ? `${volume.pageDir.path}/${name}` : path.join(volume.pageDir.path, name);
}

function editorPathFor(volume, page) {
  if (!library.editorRoot || volume.pageDir.kind !== "file") return null;
  const location = path.resolve(pageLocation(volume, page));
  if (location !== library.editorRoot && !location.startsWith(library.editorRoot + path.sep)) return null;
  return path.relative(library.editorRoot, location).replaceAll(path.sep, "/");
}

function insideEditorRoot(rel = "") {
  if (!library.editorRoot) throw new Error("此阅读器配置没有可用的本地编辑目录");
  const clean = decodeURIComponent(rel).replace(/^[/\\]+/, "");
  const full = path.resolve(library.editorRoot, clean);
  if (full !== library.editorRoot && !full.startsWith(library.editorRoot + path.sep)) {
    throw new Error(`Path outside root: ${library.editorRoot}`);
  }
  return { full, rel: path.relative(library.editorRoot, full).replaceAll(path.sep, "/") };
}

async function listEditorDir(rel) {
  const { full } = insideEditorRoot(rel);
  const entries = await fs.readdir(full, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((entry) => ({ name: entry.name, path: path.posix.join(rel || "", entry.name), type: entry.isDirectory() ? "dir" : "file" }));
}

function publishChange(event, filename) {
  const rel = filename ? String(filename).replaceAll(path.sep, "/") : "";
  const key = rel || "*";
  const pending = changeTimers.get(key);
  clearTimeout(pending?.timer);
  if (pending?.event === "rename") event = "rename";
  const timer = setTimeout(() => {
    changeTimers.delete(key);
    const message = `data: ${JSON.stringify({ event, path: rel })}\n\n`;
    for (const client of changeClients) client.write(message);
  }, 60);
  changeTimers.set(key, { timer, event });
}

function openChangeStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  res.write(`data: ${JSON.stringify({ event: "ready", path: "" })}\n\n`);
  changeClients.add(res);
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    changeClients.delete(res);
  });
}

async function editorCss() {
  try { return await fs.readFile(path.join(library.editorRoot, "mewde.css"), "utf8"); }
  catch { return "body { background: #fff; color: #1d2430; font-family: serif; line-height: 1.5; }\n"; }
}

function safeCssValue(value) {
  return /^[#\w\s(),.%+-]+$/.test(value) ? value : "#fff";
}

async function editorApi(req, res, url) {
  try {
    if (url.pathname === "/api/tree") {
      return reply(res, 200, { root: library.editorRoot, entries: await listEditorDir(url.searchParams.get("path") || "") });
    }
    if (url.pathname === "/api/events" && req.method === "GET") return openChangeStream(req, res);
    if (url.pathname === "/api/file") {
      const { full, rel } = insideEditorRoot(url.searchParams.get("path") || "");
      const stat = await fs.stat(full);
      if (!stat.isFile()) return reply(res, 400, { error: "Not a file" });
      return reply(res, 200, { path: rel, text: await fs.readFile(full, "utf8"), mtime: stat.mtimeMs });
    }
    if (url.pathname === "/api/save" && req.method === "POST") {
      const data = await jsonBody(req);
      const { full, rel } = insideEditorRoot(data.path || "");
      const before = await fs.stat(full);
      if (Number.isFinite(data.mtime) && Math.abs(before.mtimeMs - data.mtime) > 1) {
        return reply(res, 409, { error: "File changed on disk. Reload before saving.", mtime: before.mtimeMs });
      }
      await fs.writeFile(full, String(data.text ?? ""), "utf8");
      return reply(res, 200, { ok: true, path: rel, mtime: (await fs.stat(full)).mtimeMs });
    }
    if (url.pathname.startsWith("/raw/")) {
      const { full } = insideEditorRoot(url.pathname.slice(5));
      const extension = path.extname(full).toLowerCase();
      const data = await fs.readFile(full, extension === ".html" ? "utf8" : undefined);
      if (extension !== ".html") return reply(res, 200, data, MIME[extension] || "application/octet-stream");
      const themed = `<style>${await editorCss()}</style><style>body{background:${safeCssValue(url.searchParams.get("bg") || "#fff")};color:${safeCssValue(url.searchParams.get("fg") || "#1d2430")}}</style>${data}`;
      return reply(res, 200, themed, MIME[extension]);
    }
    return reply(res, 404, { error: "未知编辑器接口" });
  } catch (error) {
    return reply(res, 400, { error: error.message });
  }
}

async function readPage(volume, page) {
  const location = pageLocation(volume, page);
  if (volume.pageDir.kind === "url") {
    const response = await fetch(location);
    if (!response.ok) throw new Error(`远程页面读取失败：${response.status}`);
    return { text: await response.text(), mtime: null, editable: false };
  }
  const stat = await fs.stat(location);
  return { text: await fs.readFile(location, "utf8"), mtime: stat.mtimeMs, editable: true };
}

async function api(req, res, url) {
  try {
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/api/reader/config") {
      return reply(res, 200, {
        editorAvailable: Boolean(library.editorRoot),
        volumes: library.volumes.map(({ id, title, shortTitle, pages, toc, pdf }) => ({
          id, title, shortTitle, pages, toc,
          pdfUrl: pdf?.kind === "url" ? pdf.path : `/api/reader/pdf/${encodeURIComponent(id)}`
        }))
      });
    }
    if (url.pathname === "/api/reader/locate") {
      const { rel } = insideEditorRoot(url.searchParams.get("path") || "");
      for (const volume of library.volumes) {
        const page = volume.pages.find((candidate) => editorPathFor(volume, candidate)?.toLowerCase() === rel.toLowerCase());
        if (page != null) return reply(res, 200, { volume: volume.id, page, path: editorPathFor(volume, page) });
      }
      return reply(res, 404, { error: "此文件不属于对照阅读器配置" });
    }
    if (url.pathname === "/api/reader/settings") {
      if (req.method === "GET") return reply(res, 200, await loadReaderSettings());
      if (req.method === "PUT") {
        const settings = readerSettings(await jsonBody(req));
        await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
        return reply(res, 200, settings);
      }
      return reply(res, 405, { error: "仅支持 GET 或 PUT" });
    }
    if (parts[2] === "pdf") {
      const volume = getVolume(decodeURIComponent(parts[3] || ""));
      if (!volume.pdf || volume.pdf.kind !== "file" || !(await exists(volume.pdf.path))) {
        return reply(res, 404, "PDF not found", "text/plain; charset=utf-8");
      }
      return replyFile(req, res, volume.pdf.path, "application/pdf");
    }
    if (parts[2] === "page") {
      const volume = getVolume(decodeURIComponent(parts[3] || ""));
      const page = getPage(volume, parts[4]);
      if (req.method === "GET") {
        return reply(res, 200, { volume: volume.id, page, path: editorPathFor(volume, page), ...(await readPage(volume, page)) });
      }
      if (req.method === "PUT") {
        if (volume.pageDir.kind !== "file") return reply(res, 403, { error: "远程页面为只读" });
        const body = await jsonBody(req);
        const location = pageLocation(volume, page);
        const before = await fs.stat(location);
        if (Number.isFinite(body.mtime) && Math.abs(before.mtimeMs - body.mtime) > 1) {
          return reply(res, 409, { error: "文件已被其他程序修改，请重新载入" });
        }
        await fs.writeFile(location, String(body.text ?? ""), "utf8");
        return reply(res, 200, { ok: true, mtime: (await fs.stat(location)).mtimeMs });
      }
    }
    if (parts[2] === "link") {
      const volume = getVolume(decodeURIComponent(parts[3] || ""));
      const page = getPage(volume, parts[4]);
      const editorPath = editorPathFor(volume, page);
      if (!editorPath) return reply(res, 404, { error: "此页面不在本地编辑目录中" });
      return reply(res, 200, { volume: volume.id, page, path: editorPath });
    }
    if (parts[2] === "resource") {
      const volume = getVolume(decodeURIComponent(parts[3] || ""));
      if (volume.pageDir.kind !== "file") return reply(res, 404, "Not found", "text/plain");
      const relative = parts.slice(4).map(decodeURIComponent).join("/");
      const location = path.resolve(volume.pageDir.path, relative);
      if (location !== volume.pageDir.path && !location.startsWith(volume.pageDir.path + path.sep)) return reply(res, 403, "Forbidden", "text/plain");
      return reply(res, 200, await fs.readFile(location), MIME[path.extname(location).toLowerCase()] || "application/octet-stream");
    }
    return reply(res, 404, { error: "未知接口" });
  } catch (error) {
    return reply(res, 400, { error: error.message });
  }
}

async function staticFile(res, pathname) {
  const requested = pathname === "/" ? "/reader.html" : pathname;
  const full = path.resolve(PUBLIC, `.${requested}`);
  if (full !== PUBLIC && !full.startsWith(`${PUBLIC}${path.sep}`)) return reply(res, 403, "Forbidden", "text/plain");
  try {
    return reply(res, 200, await fs.readFile(full), MIME[path.extname(full).toLowerCase()] || "text/plain; charset=utf-8");
  } catch {
    return reply(res, 404, "Not found", "text/plain");
  }
}

async function vendorFile(res, pathname) {
  const relative = pathname.slice("/vendor/pdfjs/".length);
  const packageRoot = path.join(HERE, "node_modules", "pdfjs-dist");
  const full = path.resolve(packageRoot, relative);
  if (full !== packageRoot && !full.startsWith(`${packageRoot}${path.sep}`)) return reply(res, 403, "Forbidden", "text/plain");
  try {
    return reply(res, 200, await fs.readFile(full), MIME[path.extname(full).toLowerCase()] || "application/octet-stream");
  } catch {
    return reply(res, 404, "Not found", "text/plain");
  }
}

async function monacoFile(res, pathname) {
  const relative = pathname.slice("/monaco/".length);
  const full = path.resolve(MONACO, relative);
  if (full !== MONACO && !full.startsWith(`${MONACO}${path.sep}`)) return reply(res, 403, "Forbidden", "text/plain");
  try {
    return reply(res, 200, await fs.readFile(full), MIME[path.extname(full).toLowerCase()] || "application/octet-stream");
  } catch {
    return reply(res, 404, "Not found", "text/plain");
  }
}

await loadLibrary();
const rootWatcher = library.editorRoot ? watch(library.editorRoot, { recursive: true }, publishChange) : null;
rootWatcher?.on("error", (error) => console.error(`File watcher error: ${error.message}`));
http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/reader/")) return api(req, res, url);
  if (url.pathname === "/mewde.css") return editorCss().then((css) => reply(res, 200, css, MIME[".css"]));
  if (["/api/tree", "/api/events", "/api/file", "/api/save"].includes(url.pathname) || url.pathname.startsWith("/raw/")) return editorApi(req, res, url);
  if (url.pathname.startsWith("/vendor/pdfjs/")) return vendorFile(res, url.pathname);
  if (url.pathname.startsWith("/monaco/")) return monacoFile(res, url.pathname);
  return staticFile(res, url.pathname);
}).listen(PORT, () => console.log(`MEW 对照阅读编辑器：http://localhost:${PORT}（${library.volumes.length} 卷）`));
