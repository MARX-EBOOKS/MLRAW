const path = require("node:path");

const CONFIG_NAMES = [".mew-reader.json", "mew-reader.json"];

function formatPattern(pattern, page, volume) {
  return String(pattern)
    .replace(/\{volume(?::(\d+))?\}/g, (_, width) => String(volume ?? "").padStart(Number(width || 0), "0"))
    .replace(/\{page(?::(\d+))?\}/g, (_, width) => String(page).padStart(Number(width || 0), "0"));
}

function pageFromName(name, pattern) {
  const match = new RegExp(pattern, "i").exec(name);
  const value = match?.groups?.page ?? match?.[1];
  const page = Number(value);
  return Number.isFinite(page) ? page : null;
}

function pageFromPdfLabel(label) {
  const value = String(label ?? "").match(/^(\d+)/)?.[1];
  return value ? Number(value) : null;
}

function adjacentPage(pages, current, direction) {
  const sorted = [...new Set(pages.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  const index = sorted.indexOf(Number(current));
  if (index < 0) return null;
  return sorted[index + Math.sign(direction)] ?? null;
}

function pageAtOrBefore(pages, requested) {
  return pages.map(Number).filter(page => Number.isFinite(page) && page <= Number(requested)).sort((a, b) => b - a)[0] ?? null;
}

function normalizedVolumes(config) {
  const volumes = Array.isArray(config.volumes) && config.volumes.length ? config.volumes : [config];
  return volumes.map((volume, index) => {
    const pages = volume.pages && !Array.isArray(volume.pages) ? volume.pages : {};
    const id = String(volume.id ?? config.id ?? index + 1);
    const directory = pages.directory ?? volume.htmlRoot ?? config.htmlRoot ?? ".";
    const pattern = pages.pattern ?? volume.pagePattern ?? config.pagePattern;
    const explicitPages = Array.isArray(pages.list) ? pages.list : Array.isArray(volume.pages) ? volume.pages : [];
    const pdf = volume.pdf?.file ?? volume.pdf ?? config.pdf?.file ?? config.pdf;
    if (!pattern) throw new Error(`卷册 ${id} 缺少 pages.pattern/pagePattern`);
    if (!pdf) throw new Error(`卷册 ${id} 缺少 pdf`);
    return {
      id,
      title: String(volume.title ?? config.title ?? `PDF ${id}`),
      shortTitle: String(volume.shortTitle ?? volume.title ?? config.shortTitle ?? config.title ?? id),
      directory: String(directory), pattern: String(pattern), pdf: String(pdf),
      pageLabel: String(volume.pageLabel ?? config.pageLabel ?? "{page}"),
      toc: Array.isArray(volume.toc) ? volume.toc : [],
      explicitPages: [...new Set(explicitPages.map(Number).filter(Number.isFinite))].sort((a, b) => a - b)
    };
  });
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// —— 与 VS Code 资源管理器文件列表一致的排序（约 30 行）——
function sortExplorerFiles(files, { sortOrder = "default", lexicographicOptions: lex = "default", reverse = false } = {}) {
  const direction = reverse ? -1 : 1;
  const collator = new Intl.Collator(undefined, { numeric: true });
  const extCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "accent" });
  const compareWith = (c, a, b) => c.compare(a, b) || (a.length < b.length ? -1 : a.length > b.length ? 1 : 0);
  const charCase = ch => /[A-Z]/.test(ch) ? 1 : /[a-z]/.test(ch) ? -1 : ch.toLocaleLowerCase() !== ch ? 1 : ch.toLocaleUpperCase() !== ch ? -1 : 0;
  const caseResult = (a, b) => {
    if (lex !== "upper" && lex !== "lower") return 0;
    const ca = charCase(a.charAt(0)), cb = charCase(b.charAt(0));
    return ca && cb && ca !== cb ? (lex === "upper" ? cb - ca : ca - cb) : 0;
  };
  const extension = name => {
    const match = /^(.*?)(\.([^.]*))?$/.exec(name);
    return match && match[1] && match[1].charAt(0) !== "." && match[3] ? match[3] : "";
  };
  const byName = (a, b) => lex === "unicode" ? (a === b ? 0 : a < b ? -1 : 1) : caseResult(a, b) || compareWith(collator, a, b);
  const byExtension = (a, b) => {
    if (lex === "unicode") {
      const x = extension(a).toLowerCase(), y = extension(b).toLowerCase();
      return (x === y ? 0 : x < y ? -1 : 1) || (a === b ? 0 : a < b ? -1 : 1);
    }
    return compareWith(extCollator, extension(a), extension(b)) || caseResult(a, b) || compareWith(collator, a, b);
  };
  const byFile = (a, b) => sortOrder === "type" ? byExtension(a.name, b.name)
    : sortOrder === "modified" && a.mtime !== b.mtime ? (a.mtime < b.mtime ? 1 : -1) : byName(a.name, b.name);
  return [...files].sort((a, b) => direction * byFile(a, b));
}

function resolveUri(vscode, base, value) {
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return vscode.Uri.parse(value);
  if (path.isAbsolute(value)) return vscode.Uri.file(value);
  return vscode.Uri.joinPath(base, ...value.replace(/\\/g, "/").split("/"));
}

async function findConfig(vscode, uri) {
  const setting = vscode.workspace.getConfiguration("mewReader", uri).get("configFile", "").trim();
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (setting) {
    const base = workspaceFolder?.uri || vscode.Uri.joinPath(uri, "..");
    const candidate = resolveUri(vscode, base, setting);
    try { await vscode.workspace.fs.stat(candidate); return candidate; } catch { throw new Error(`找不到配置文件：${candidate.fsPath || candidate.path}`); }
  }
  let directory = vscode.Uri.joinPath(uri, "..");
  const stop = workspaceFolder?.uri;
  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = vscode.Uri.joinPath(directory, name);
      try { await vscode.workspace.fs.stat(candidate); return candidate; } catch { }
    }
    if (stop && directory.toString(true) === stop.toString(true)) break;
    const parent = vscode.Uri.joinPath(directory, "..");
    if (parent.toString(true) === directory.toString(true) || (stop && !isInside(path.resolve(parent.fsPath), path.resolve(stop.fsPath)))) break;
    directory = parent;
  }
  return null;
}
module.exports = { findConfig, resolveUri, sortExplorerFiles, CONFIG_NAMES, formatPattern, pageFromName, pageFromPdfLabel, adjacentPage, pageAtOrBefore, normalizedVolumes, isInside };
