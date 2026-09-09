import http from "node:http";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
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
  if (htmlRoot.kind === "file" && !(await exists(htmlRoot.path)) && config.htmlRoot === "./MEWB") {
    htmlRoot = resolveResource("../MEWB", base);
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
  library = { config, volumes };
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
        volumes: library.volumes.map(({ id, title, shortTitle, pages, toc, pdf }) => ({
          id, title, shortTitle, pages, toc,
          pdfUrl: pdf?.kind === "url" ? pdf.path : `/api/reader/pdf/${encodeURIComponent(id)}`
        }))
      });
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
        return reply(res, 200, { volume: volume.id, page, ...(await readPage(volume, page)) });
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

await loadLibrary();
http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/reader/")) return api(req, res, url);
  if (url.pathname.startsWith("/vendor/pdfjs/")) return vendorFile(res, url.pathname);
  return staticFile(res, url.pathname);
}).listen(PORT, () => console.log(`MEW 对照阅读编辑器：http://localhost:${PORT}（${library.volumes.length} 卷）`));
