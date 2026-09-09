import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inhalt } from "../reader.contents.mjs";

const output = process.argv[2];
if (!output) throw new Error("用法：node generate-mew-brief-config.mjs <MEW_BRIEF/.mew-reader.json>");

const volumes = Object.entries(inhalt).map(([id, entries]) => ({
  id,
  title: `马克思恩格斯全集 第${id}卷`,
  shortTitle: `第${id}卷`,
  htmlRoot: id,
  pdf: `../马恩全集德文/mew_band${String(id).padStart(2, "0")}.pdf`,
  pagePattern: `^ME${String(id).padStart(2, "0")}-(?<page>\\d+)\\.html?$`,
  pageLabel: "{page}",
  toc: entries.map(([heading, page]) => ({
    title: String(heading).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim(),
    level: Number(String(heading).match(/^\s*<h([1-6])/i)?.[1] || 1),
    page: Number(page)
  })).filter(entry => entry.title && Number.isFinite(entry.page))
}));

const config = {
  title: "马克思恩格斯全集",
  volumes
};
await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
await fs.writeFile(path.resolve(output), `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(`已写入 ${path.resolve(output)}：${volumes.length} 卷，${volumes.reduce((sum, volume) => sum + volume.toc.length, 0)} 条目录。`);
