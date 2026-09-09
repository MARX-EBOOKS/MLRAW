import http from "node:http";
import { promises as fs, watch, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = getRoot();
const PUBLIC = path.join(__dirname, "public");
const MONACO = existsSync(path.join(__dirname, "monaco", "min", "vs", "loader.js"))
  ? path.join(__dirname, "monaco") : path.join(__dirname, "node_modules", "monaco-editor");
const MEWDE = path.join(ROOT, "mewde.css");
const PORT = getPort();
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const DEFAULT_CSS = `body { background: #fff; color: #1d2430; font-family: "Times New Roman", serif; line-height: 1.5; }\na { color: #1167b1; }\n`;
const changeClients = new Set();
const changeTimers = new Map();

function argValue(names) {
  const args = process.argv.slice(2);
  for (const name of names) {
    const eq = args.find(a => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const i = args.findIndex(a => a === name);
    if (i >= 0) return args[i + 1];
  }
  return "";
}

function getPort() {
  const value = argValue(["-p", "--port", "PORT"]) || process.env.PORT || "4127";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("Use a valid port: node server.js -p 4127");
    process.exit(1);
  }
  return port;
}

function getRoot() {
  const value = argValue(["-r", "--root", "ROOT"]) || process.env.ROOT || path.resolve(__dirname, "..", "MEW_BRIEF");
  return path.resolve(value);
}

function send(res, code, data, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(Buffer.isBuffer(data) || typeof data === "string" ? data : JSON.stringify(data));
}

function insideRoot(rel = "") {
  const clean = decodeURIComponent(rel).replace(/^[/\\]+/, "");
  const full = path.resolve(ROOT, clean);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new Error(`Path outside root: ${ROOT}`);
  return { full, rel: path.relative(ROOT, full).replaceAll(path.sep, "/") };
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
async function customCss() {
  try { return await fs.readFile(MEWDE, "utf8"); }
  catch { await fs.writeFile(MEWDE, DEFAULT_CSS, "utf8"); return DEFAULT_CSS; }
}
function safeCssValue(v) {
  return /^[#\w\s(),.%+-]+$/.test(v) ? v : "#fff";
}
async function rawHtml(text, bg = "#fff", fg = "#1d2430") {
  return `<style>${await customCss()}</style><style>body{background:${safeCssValue(bg)};color:${safeCssValue(fg)}}</style>` + text;
}

async function listDir(rel) {
  const { full } = insideRoot(rel);
  const entries = await fs.readdir(full, { withFileTypes: true });
  return entries
    .filter(e => !e.name.startsWith("."))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map(e => ({ name: e.name, path: path.posix.join(rel || "", e.name), type: e.isDirectory() ? "dir" : "file" }));
}

function publishChange(event, filename) {
  const rel = filename ? String(filename).replaceAll(path.sep, "/") : "";
  const key = rel || "*";
  const pending = changeTimers.get(key);
  clearTimeout(pending?.timer);
  // 同一路径的 rename 不能被随后到来的内容 change 覆盖。
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
    "connection": "keep-alive"
  });
  res.write(`data: ${JSON.stringify({ event: "ready", path: "" })}\n\n`);
  changeClients.add(res);
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    changeClients.delete(res);
  });
}

async function api(req, res, url) {
  try {
    if (url.pathname === "/api/tree") return send(res, 200, { root: ROOT, entries: await listDir(url.searchParams.get("path") || "") });
    if (url.pathname === "/api/events" && req.method === "GET") return openChangeStream(req, res);
    if (url.pathname === "/api/file") {
      const { full, rel } = insideRoot(url.searchParams.get("path") || "");
      const st = await fs.stat(full);
      if (!st.isFile()) return send(res, 400, { error: "Not a file" });
      return send(res, 200, { path: rel, text: await fs.readFile(full, "utf8"), mtime: st.mtimeMs });
    }
    if (url.pathname === "/api/save" && req.method === "POST") {
      const data = await body(req);
      const { full, rel } = insideRoot(data.path || "");
      const st0 = await fs.stat(full);
      if (Number.isFinite(data.mtime) && Math.abs(st0.mtimeMs - data.mtime) > 1) {
        return send(res, 409, { error: "File changed on disk. Reload before saving.", mtime: st0.mtimeMs });
      }
      await fs.writeFile(full, data.text ?? "", "utf8");
      const st = await fs.stat(full);
      return send(res, 200, { ok: true, path: rel, mtime: st.mtimeMs });
    }
    if (url.pathname.startsWith("/raw/")) {
      const { full } = insideRoot(url.pathname.slice(5));
      const ext = path.extname(full).toLowerCase();
      const data = await fs.readFile(full, ext === ".html" ? "utf8" : undefined);
      return send(res, 200, ext === ".html" ? await rawHtml(data, url.searchParams.get("bg") || "#fff", url.searchParams.get("fg") || "#1d2430") : data, TYPES[ext] || "text/plain; charset=utf-8");
    }
    send(res, 404, { error: "Unknown API route" });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}

async function staticFile(res, pathname) {
  const reqPath = pathname === "/" ? "/index.html" : pathname;
  if (reqPath === "/mewde.css") return send(res, 200, await customCss(), TYPES[".css"]);
  const assetRoot = reqPath.startsWith("/monaco/") ? MONACO : PUBLIC;
  const assetPath = reqPath.startsWith("/monaco/") ? reqPath.slice(7) : reqPath;
  try {
    const full = path.resolve(assetRoot, "." + decodeURIComponent(assetPath));
    if (!full.startsWith(assetRoot + path.sep)) return send(res, 403, "Forbidden", "text/plain");
    const ext = path.extname(full).toLowerCase();
    send(res, 200, await fs.readFile(full), TYPES[ext] || (ext === ".ttf" ? "font/ttf" : "application/octet-stream"));
  } catch {
    send(res, 404, "Not found", "text/plain");
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/raw/")) return api(req, res, url);
  staticFile(res, url.pathname);
});

const rootWatcher = watch(ROOT, { recursive: true }, publishChange);
rootWatcher.on("error", error => console.error(`File watcher error: ${error.message}`));
server.listen(PORT, () => console.log(`MEW HTML editor: http://localhost:${PORT}`));
