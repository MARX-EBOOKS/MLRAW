const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("missing reader JSON falls through to the original sibling navigator", () => {
  const source = fs.readFileSync(require.resolve("../extension.cjs"), "utf8");
  const start = source.indexOf("async function openSiblingFile(direction)");
  const readerAttempt = source.indexOf("if (await reader.navigate(direction)) return;", start);
  const ordinaryNavigation = source.indexOf("const current = activeFile();", readerAttempt);
  const siblingRead = source.indexOf("const files = await siblingFiles", ordinaryNavigation);
  assert.ok(start >= 0 && readerAttempt > start && ordinaryNavigation > readerAttempt && siblingRead > ordinaryNavigation);
});
