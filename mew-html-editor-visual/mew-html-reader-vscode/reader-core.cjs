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

module.exports = { CONFIG_NAMES, formatPattern, pageFromName, pageFromPdfLabel, adjacentPage, pageAtOrBefore, normalizedVolumes, isInside };
