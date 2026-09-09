const test = require("node:test");
const assert = require("node:assert/strict");
const { formatPattern, pageFromName, pageFromPdfLabel, adjacentPage, pageAtOrBefore, normalizedVolumes } = require("../reader-core.cjs");

test("patterns and labels follow reader.html semantics", () => {
  assert.equal(formatPattern("ME{volume:02}-{page:03}.html", 7, 4), "ME04-007.html");
  assert.equal(pageFromName("ME04-007.html", "^ME04-(?<page>\\d+)\\.html$"), 7);
  assert.equal(pageFromPdfLabel("17a"), 17);
  assert.equal(pageFromPdfLabel("iv"), null);
});

test("adjacent navigation uses actual configured pages and does not wrap", () => {
  assert.equal(adjacentPage([3, 4, 8], 4, 1), 8);
  assert.equal(adjacentPage([3, 4, 8], 3, -1), null);
  assert.equal(adjacentPage([3, 4, 8], 8, 1), null);
  assert.equal(pageAtOrBefore([3, 4, 8], 7), 4);
  assert.equal(pageAtOrBefore([3, 4, 8], 2), null);
});

test("single-volume JSON is normalized", () => {
  const [volume] = normalizedVolumes({ title: "Band 4", htmlRoot: "pages", pdf: "book.pdf", pagePattern: "(\\d+)" });
  assert.equal(volume.title, "Band 4");
  assert.equal(volume.directory, "pages");
  assert.equal(volume.pdf, "book.pdf");
});
