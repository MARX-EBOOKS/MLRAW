import http from "node:http";
import { createReadStream, existsSync, watch } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, process.argv.includes("--legacy") ? "public_legacy" : "public");
const MONACO = existsSync(path.join(HERE, "monaco", "min", "vs", "loader.js"))
  ? path.join(HERE, "monaco")
  : path.join(HERE, "node_modules", "monaco-editor");
const PDFJS = path.join(HERE, "node_modules", "pdfjs-dist");
const SETTINGS_FILE = path.join(HERE, "reader.settings.json");
const CONFIG_NAMES = [".mew-reader.json", "mew-reader.json"];

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

function findDefaultConfig() {
  const explicit = valueOf(["-c", "--config"]) || process.env.CONFIG;
  if (explicit) return path.resolve(explicit);

  let directory = process.cwd();
  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return [
    path.join(HERE, ".mew-reader.json"),
    path.join(HERE, "../MEW_BRIEF/.mew-reader.json"),
    path.join(HERE, "../MECW_reconv/.mew-reader.json")
  ].find(existsSync) || path.join(HERE, ".mew-reader.json");
}

const CONFIG_FILE = findDefaultConfig();
const PORT = Number(valueOf(["-p", "--port"]) || process.env.PORT || 49100);

const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".pdf": "application/pdf", ".wasm": "application/wasm",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"
};

let library;
const changeClients = new Set();
const changeTimers = new Map();

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
  const color = (input, fallback) =>
    /^#[0-9a-f]{6}$/i.test(String(input)) ? String(input).toLowerCase() : fallback;
  return {
    brightness: Math.max(50, Math.min(160, Number(value.brightness) || 100)),
    paper: color(value.paper, "#ffffff"),
    ink: color(value.ink, "#000000"),
    invert: Boolean(value.invert),
    horizontal: Boolean(value.horizontal),
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

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

function pageFromName(name, pattern) {
  const match = new RegExp(pattern, "i").exec(name);
  const page = Number(match?.groups?.page ?? match?.[1]);
  return Number.isFinite(page) ? page : null;
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizedVolumes(config) {
  const volumes = Array.isArray(config.volumes) && config.volumes.length ? config.volumes : [config];
  return volumes.map((volume, index) => {
    const pages = volume.pages && !Array.isArray(volume.pages) ? volume.pages : {};
    const id = String(volume.id ?? config.id ?? index + 1);
    const directory = pages.directory ?? volume.htmlRoot ?? config.htmlRoot ?? ".";
    const pattern = pages.pattern ?? volume.pagePattern ?? config.pagePattern;
    const explicitPages = Array.isArray(pages.list) ? pages.list
      : Array.isArray(volume.pages) ? volume.pages : [];
    const pdf = volume.pdf?.file ?? volume.pdf ?? config.pdf?.file ?? config.pdf;
    if (!pattern) throw new Error(`卷册 ${id} 缺少 pages.pattern/pagePattern`);
    if (!pdf) throw new Error(`卷册 ${id} 缺少 pdf`);
    return {
      id,
      title: String(volume.title ?? config.title ?? `PDF ${id}`),
      shortTitle: String(volume.shortTitle ?? volume.title ?? config.shortTitle ?? config.title ?? id),
      directory: String(directory),
      pattern: String(pattern),
      pdf: String(pdf),
      pageLabel: String(volume.pageLabel ?? config.pageLabel ?? "{page}"),
      toc: Array.isArray(volume.toc) ? volume.toc : [],
      explicitPages: [...new Set(explicitPages.map(Number).filter(Number.isFinite))].sort((a, b) => a - b)
    };
  });
}

function expandVolumeDirectory(config, dir) {
  const raw = String(dir ?? ".");
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) || path.isAbsolute(raw)) return raw;
  if (!config.htmlRoot) return raw;
  const root = String(config.htmlRoot).replace(/\\/g, "/").replace(/\/+$/, "");
  const value = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (value === "" || value === ".") return root;
  if (value === root || value.startsWith(`${root}/`)) return raw;
  return `${root}/${value}`;
}

async function replyFile(req, res, location, type) {
  const stat = await fs.stat(location);
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!range) {
    res.writeHead(200, {
      "content-type": type, "content-length": stat.size,
      "accept-ranges": "bytes", "cache-control": "no-store"
    });
    return req.method === "HEAD" ? res.end() : createReadStream(location).pipe(res);
  }
  let start = range[1] ? Number(range[1]) : 0;
  let end = range[2] ? Number(range[2]) : stat.size - 1;
  if (!range[1] && range[2]) start = Math.max(0, stat.size - Number(range[2]));
  end = Math.min(end, stat.size - 1);
  if (start < 0 || start > end) {
    res.writeHead(416, { "content-range": `bytes */${stat.size}` });
    return res.end();
  }
  res.writeHead(206, {
    "content-type": type, "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${stat.size}`,
    "accept-ranges": "bytes", "cache-control": "no-store"
  });
  return req.method === "HEAD" ? res.end() : createReadStream(location, { start, end }).pipe(res);
}

function normalizeToc(list) {
  return (list || []).map(entry => Array.isArray(entry)
    ? {
      title: String(entry[0]).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim(),
      level: Number(String(entry[0]).match(/^\s*<h([1-6])/i)?.[1] || 1),
      page: Number(entry[1])
    }
    : { title: entry.title, level: Number(entry.level || 1), page: Number(entry.page) }
  ).filter(entry => entry.title && Number.isFinite(entry.page));
}

async function scanPageFiles(pageDir, pattern, explicitPages = []) {
  const pageFiles = new Map();
  if (pageDir.kind === "file" && await exists(pageDir.path)) {
    const names = await fs.readdir(pageDir.path);
    for (const name of names) {
      const page = pageFromName(name, pattern);
      if (page != null && !pageFiles.has(page)) pageFiles.set(page, name);
    }
  }
  for (const page of explicitPages) {
    if (!pageFiles.has(page)) pageFiles.set(page, null);
  }
  return pageFiles;
}

async function loadLibrary() {
  const config = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8"));
  const base = path.dirname(CONFIG_FILE);
  const volumes = [];

  for (const item of normalizedVolumes(config)) {
    const pageDir = resolveResource(expandVolumeDirectory(config, item.directory), base);
    const pageFiles = await scanPageFiles(pageDir, item.pattern, item.explicitPages);
    const pages = [...pageFiles.keys()].sort((a, b) => a - b);
    if (!pages.length) continue;
    volumes.push({
      id: item.id,
      title: item.title,
      shortTitle: item.shortTitle,
      pages,
      toc: normalizeToc(item.toc),
      pageDir,
      pageRegex: item.pattern,
      pageFiles,
      pageLabel: item.pageLabel,
      pdf: resolveResource(item.pdf, base)
    });
  }

  const editorSrc = config.editorRoot ? resolveResource(config.editorRoot, base) : { kind: "file", path: base };
  const editorRoot = editorSrc.kind === "file" && await exists(editorSrc.path) ? path.resolve(editorSrc.path) : null;

  library = { config, volumes, editorRoot };
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
  const name = volume.pageFiles.get(page);
  if (!name) throw new Error(`第 ${page} 页没有对应文件`);
  return name;
}

function pageLocation(volume, page) {
  const name = pageName(volume, page);
  return volume.pageDir.kind === "url"
    ? `${volume.pageDir.path}/${name}`
    : path.join(volume.pageDir.path, name);
}

function editorPathFor(volume, page) {
  if (!library.editorRoot || volume.pageDir.kind !== "file") return null;
  const location = path.resolve(pageLocation(volume, page));
  if (!isInside(location, library.editorRoot)) return null;
  return path.relative(library.editorRoot, location).replaceAll(path.sep, "/");
}

function insideEditorRoot(rel = "") {
  if (!library.editorRoot) throw new Error("此阅读器配置没有可用的本地编辑目录");
  const clean = decodeURIComponent(rel).replace(/^[/\\]+/, "");
  const full = path.resolve(library.editorRoot, clean);
  if (!isInside(full, library.editorRoot)) throw new Error(`Path outside root: ${library.editorRoot}`);
  return { full, rel: path.relative(library.editorRoot, full).replaceAll(path.sep, "/") };
}

async function listEditorDir(rel) {
  const { full } = insideEditorRoot(rel);
  const entries = await fs.readdir(full, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory())
      || a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((entry) => ({
      name: entry.name,
      path: path.posix.join(rel || "", entry.name),
      type: entry.isDirectory() ? "dir" : "file"
    }));
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

function validFileTarget(rel) {
  const target = insideEditorRoot(rel);
  const name = path.basename(target.full);
  if (!target.rel || name === "." || name === ".." || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || /[. ]$/.test(name)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error("Invalid file name");
  }
  return target;
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
    if (url.pathname === "/api/create" && req.method === "POST") {
      const data = await jsonBody(req);
      const { full, rel } = validFileTarget(data.path || "");
      const parent = await fs.stat(path.dirname(full));
      if (!parent.isDirectory()) return reply(res, 400, { error: "Target directory does not exist" });
      let existing = null;
      try { existing = await fs.stat(full); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (existing && !data.overwrite) {
        return reply(res, 409, { error: "A file with this name already exists.", code: "FILE_EXISTS", mtime: existing.mtimeMs });
      }
      if (existing) {
        if (!existing.isFile()) return reply(res, 400, { error: "Target is not a file" });
        if (!Number.isFinite(data.mtime) || Math.abs(existing.mtimeMs - data.mtime) > 1) {
          return reply(res, 409, { error: "Target file changed before it could be overwritten.", code: "TARGET_CHANGED", mtime: existing.mtimeMs });
        }
        await fs.writeFile(full, data.text ?? "", "utf8");
      } else {
        let handle;
        try { handle = await fs.open(full, "wx"); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          const raced = await fs.stat(full);
          return reply(res, 409, { error: "A file with this name already exists.", code: "FILE_EXISTS", mtime: raced.mtimeMs });
        }
        try { await handle.writeFile(data.text ?? "", "utf8"); }
        finally { await handle.close(); }
      }
      const st = await fs.stat(full);
      return reply(res, 201, { ok: true, path: rel, mtime: st.mtimeMs });
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
      await Promise.all(library.volumes.map(async (volume) => {
        if (volume.pageDir.kind !== "file") return;
        const refreshed = await scanPageFiles(volume.pageDir, volume.pageRegex);
        for (const [page, name] of volume.pageFiles) {
          if (name == null && !refreshed.has(page)) refreshed.set(page, null);
        }
        volume.pageFiles = refreshed;
        volume.pages = [...refreshed.keys()].sort((a, b) => a - b);
      }));
      return reply(res, 200, {
        title: library.config.title || "阅读器",
        configPath: CONFIG_FILE,
        editorRoot: library.editorRoot,
        editorAvailable: Boolean(library.editorRoot),
        volumes: library.volumes.map(({ id, title, shortTitle, pages, toc, pdf, pageLabel }) => ({
          id, title, shortTitle, pages, toc, pageLabel,
          pdfUrl: pdf?.kind === "url" ? pdf.path : `/api/reader/pdf/${encodeURIComponent(id)}`
        }))
      });
    }

    if (url.pathname === "/api/reader/locate") {
      if (!library.editorRoot) return reply(res, 404, { error: "此配置没有本地编辑目录" });
      const { rel } = insideEditorRoot(url.searchParams.get("path") || "");
      for (const volume of library.volumes) {
        const page = volume.pages.find(
          (candidate) => editorPathFor(volume, candidate)?.toLowerCase() === rel.toLowerCase()
        );
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
        return reply(res, 200, {
          volume: volume.id, page,
          path: editorPathFor(volume, page),
          ...(await readPage(volume, page))
        });
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
      if (!isInside(location, volume.pageDir.path)) return reply(res, 403, "Forbidden", "text/plain");
      return reply(res, 200, await fs.readFile(location), MIME[path.extname(location).toLowerCase()] || "application/octet-stream");
    }

    return reply(res, 404, { error: "未知接口" });
  } catch (error) {
    return reply(res, 400, { error: error.message });
  }
}

// 三个静态目录共用一套逻辑，只是根目录和前缀不同
async function serveAsset(res, pathname, root, prefix = "", stripSlash = false) {
  const relative = prefix ? pathname.slice(prefix.length) : pathname.replace(/^\/+/, "");
  const full = path.resolve(root, stripSlash ? `.${pathname === "/" ? "/reader.html" : pathname}` : relative);
  if (!isInside(full, root)) return reply(res, 403, "Forbidden", "text/plain");
  try {
    const type = MIME[path.extname(full).toLowerCase()] || (root === PUBLIC ? "text/plain; charset=utf-8" : "application/octet-stream");
    return reply(res, 200, await fs.readFile(full), type);
  } catch {
    return reply(res, 404, "Not found", "text/plain");
  }
}

try {
  await loadLibrary();
} catch (error) {
  console.error(`加载配置失败（${CONFIG_FILE}）：${error.message}`);
  process.exit(1);
}

if (!library.volumes.length) {
  console.error(`配置 ${CONFIG_FILE} 没有扫描到任何卷。请检查顶层 htmlRoot、每卷 htmlRoot 与 pagePattern。`);
  process.exit(1);
}

const rootWatcher = library.editorRoot
  ? watch(library.editorRoot, { recursive: true }, publishChange)
  : null;
rootWatcher?.on("error", (error) => console.error(`File watcher error: ${error.message}`));

for (const directory of new Set(
  library.volumes.filter((volume) => volume.pageDir.kind === "file").map((volume) => volume.pageDir.path)
)) {
  const relative = library.editorRoot ? path.relative(library.editorRoot, directory) : null;
  if (relative != null && !relative.startsWith("..") && !path.isAbsolute(relative)) continue;
  if (!existsSync(directory)) continue;
  const watcher = watch(directory, () => publishChange("rename", ""));
  watcher.on("error", (error) => console.error(`File watcher error: ${error.message}`));
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/reader/")) return api(req, res, url);
  if (url.pathname === "/mewde.css") return editorCss().then((css) => reply(res, 200, css, MIME[".css"]));
  if (["/api/tree", "/api/events", "/api/file", "/api/save", "/api/create"].includes(url.pathname)
    || url.pathname.startsWith("/raw/")) return editorApi(req, res, url);
  if (url.pathname.startsWith("/vendor/pdfjs/")) return serveAsset(res, url.pathname, PDFJS, "/vendor/pdfjs/");
  if (url.pathname.startsWith("/monaco/")) return serveAsset(res, url.pathname, MONACO, "/monaco/");
  return serveAsset(res, url.pathname, PUBLIC, "", true);
}).listen(PORT, () => {
  console.log(`配置：${CONFIG_FILE}`);
  console.log(`编辑根：${library.editorRoot || "（无）"}`);
  console.log(`阅读器：http://localhost:${PORT}（${library.volumes.length} 卷）`);
});