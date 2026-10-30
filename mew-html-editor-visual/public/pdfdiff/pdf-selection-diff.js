"use strict";
let diffComputer = null;
function significantText(text, index, start = 0) {
  return text.replace(/[\s\-\u00ad\u2010\u2011\d]/g, (char, offset) => /\d/.test(char)
    && !(index?.formats?.[start + offset]?.name === 'a'
      && /\bhref\s*=\s*(["'])#Z?F\d+\1/i.test(index.formats[start + offset].definition.opening)) ? char : '').replace(/[^\x00-\x7f]+/g, value => normalized(value, undefined, 0, false).text.replace(/\s/g, ''));
}
function rangeAt(model, start, end, index) {
  if (index) [start, end] = [index.starts[start] ?? index.source.length,
    (end > start ? index.ends[end - 1] : index.starts[start]) ?? index.source.length];
  const a = model.getPositionAt(start), b = model.getPositionAt(end);
  return { startLineNumber: a.lineNumber, startColumn: a.column,
    endLineNumber: b.lineNumber, endColumn: b.column };
}
function validateEdits(source, edits) {
  const sorted = edits.map(edit => ({ ...edit })).sort((a, b) => a.start - b.start || a.end - b.end);
  let previous = null;
  for (const edit of sorted) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < 0
      || edit.end < edit.start || edit.end > source.length || typeof edit.text !== 'string') throw new Error('无效的替换范围');
    if (previous && (edit.start < previous.end || edit.start === previous.start)) throw new Error('替换范围重叠，请逐条处理');
    if (edit.expected !== undefined && source.slice(edit.start, edit.end) !== edit.expected) throw new Error('原文已变化，无法应用旧修改');
    previous = edit;
  }
  return sorted;
}
function previewEdits(source, edits) {
  const sorted = validateEdits(source, edits);
  return sorted.map((edit, i) => source.slice(sorted[i - 1]?.end ?? 0, edit.start) + edit.text).join('')
    + source.slice(sorted.at(-1)?.end ?? 0);
}
function applyEdits(editor, model, version, source, edits, origin = 'review-replacement') {
  if (editor.getModel() !== model || model.getValue() !== source
    || (version !== undefined && model.getVersionId?.() !== version)) throw new Error('编辑器内容已变化，无法应用旧修改');
  const api = editor.getDomNode?.()?.ownerDocument.defaultView.monaco;
  if (editor.getOption?.(api?.editor.EditorOption.readOnly ?? 104)) throw new Error('当前文件只读');
  const checked = validateEdits(source, edits);
  if (!checked.length) return;
  editor.pushUndoStop?.();
  const applied = editor.executeEdits(origin, checked.map(edit => ({ range: rangeAt(model, edit.start, edit.end), text: edit.text, forceMoveMarkers: true })));
  editor.pushUndoStop?.();
  if (applied === false) throw new Error('编辑器未能应用替换');
}
function textDiff(left, right, details = false, limit = Infinity, condense = false) {
  if (left === right) return { distance: 0, parts: details ? (left ? [{ html: left, pdf: right, changed: false }] : []) : undefined };
  // A bounded match cannot span more extra characters than its edit limit.
  if (Number.isFinite(limit) && Math.abs(left.length - right.length) > limit && Math.abs(Array.from(left).length - Array.from(right).length) > limit)
    return { distance: limit + 1, parts: details ? [{ html: left, pdf: right, changed: true }] : undefined };
  // Connections condense word runs before the same character refinement used by selections.
  if (condense || !diffComputer || !details && Number.isFinite(limit)) return localTextDiff(left, right, details, condense ? limit : details ? Math.min(limit, 128) : limit);
  const fallback = details ? localTextDiff(left, right, true, 128) : null;
  if (fallback?.distance <= 128) return fallback;
  try {
    const result = diffComputer.computeDiff(left.split("\n"), right.split("\n"), {
      ignoreTrimWhitespace: false, maxComputationTimeMs: 1000,
      computeMoves: false, extendToSubwords: false
    });
    if (result.hitTimeout) throw new Error("Monaco diff timed out");
    const offsets = text => {
      const starts = [0];
      for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
      return range => starts[range.startLineNumber - 1] + range.startColumn - 1;
    };
    const offsetA = offsets(left), offsetB = offsets(right), parts = [];
    let a = 0, b = 0, distance = 0;
    for (const change of result.changes) {
      if (!change.innerChanges?.length) throw new Error("Missing Monaco character ranges");
      for (const { originalRange: x, modifiedRange: y } of change.innerChanges) {
        const startA = offsetA(x), startB = offsetB(y);
        const endA = offsetA({ startLineNumber: x.endLineNumber, startColumn: x.endColumn });
        const endB = offsetB({ startLineNumber: y.endLineNumber, startColumn: y.endColumn });
        if (![startA, endA, startB, endB].every(Number.isInteger) || startA < a || startB < b
          || endA < startA || endB < startB || endA > left.length || endB > right.length
          || left.slice(a, startA) !== right.slice(b, startB)) throw new Error("Invalid Monaco ranges");
        let changeDistance = Math.max(Array.from(left.slice(startA, endA)).length, Array.from(right.slice(startB, endB)).length);
        if (details) {
          appendPart(parts, left.slice(a, startA), right.slice(b, startB), false);
          // Refine each hunk even when the whole passage exceeds the edit budget.
          const html = left.slice(startA, endA), pdf = right.slice(startB, endB);
          const refined = localTextDiff(html, pdf, true, 128);
          if (refined.distance <= 128) changeDistance = refined.distance;
          for (const part of refined.parts) appendPart(parts, part.html, part.pdf, part.changed);
        }
        distance += changeDistance;
        a = endA; b = endB;
      }
    }
    if (left.slice(a) !== right.slice(b)) throw new Error("Incomplete Monaco ranges");
    if (details) appendPart(parts, left.slice(a), right.slice(b), false);
    return { distance, parts: details ? parts : undefined };
  } catch { /* Retry Monaco on the next comparison. */ }
  return fallback && limit >= 128 ? fallback : localTextDiff(left, right, details, limit);
}
// Detailed unbounded text uses word alignment; bounded/token checks use the edit wavefront.
function localTextDiff(left, right, details = false, limit = Infinity, equal = (a, b) => a === b, substitutions = true) {
  const wordwise = details && typeof left === 'string' && !Number.isFinite(limit);
  if (wordwise) {
    const words = text => text.match(/[\p{L}\p{N}]+(?:[-\u2010\u2011][\p{L}\p{N}]+)*\s*|[^\s]\s*|\s+/gu) || [];
    left = words(left); right = words(right); limit = 1024;
    equal = (a, b) => a.trimEnd() === b.trimEnd() || /^[.,\s]+$/u.test(a + b);
  }
  const originalA = [...left], originalB = [...right];
  const { start, oldEnd: endA, newEnd: endB } = changedRange(originalA, originalB, equal);
  const a = originalA.slice(start, endA), b = originalB.slice(start, endB), n = a.length, m = b.length;
  const bound = Math.min(limit, details && typeof left === 'string' ? 128 : Infinity, Math.max(n, m));
  let previous = new Int32Array([0]), distance = Math.abs(n - m) > bound ? bound + 1 : 0;
  const waves = details ? [{ row: previous, trace: null }] : null;
  for (; distance < bound && previous[n - m + distance] !== n; ) {
    const score = ++distance, row = new Int32Array(2 * score + 1).fill(-1);
    const trace = details ? new Uint8Array(row.length) : null;
    for (let k = Math.max(-score, -m); k <= Math.min(score, n); k++) {
      const at = k + score - 1;
      const replace = previous[at], remove = previous[at - 1], insert = previous[at + 1];
      let x = substitutions && replace >= 0 && replace < n && replace - k < m ? replace + 1 : -1, move = 0;
      if (remove >= 0 && remove < n && remove + 1 > x) { x = remove + 1; move = 1; }
      if (insert >= 0 && insert - k - 1 < m && insert > x) { x = insert; move = 2; }
      if (x < 0) continue;
      let y = x - k;
      while (x < n && y < m && equal(a[x], b[y])) { x++; y++; }
      row[k + score] = x;
      if (trace) trace[k + score] = move;
    }
    previous = row;
    if (details) waves.push({ row, trace });
  }
  const failed = distance > bound || previous[n - m + distance] !== n;
  if (failed) distance = bound + 1;
  if (!details) return { distance };
  const reversed = [];
  let x = n, k = n - m;
  for (let score = failed ? 0 : distance; score > 0; score--) {
    const move = waves[score].trace[k + score], previousK = k + (move === 1 ? -1 : move === 2 ? 1 : 0);
    const previousX = waves[score - 1].row[previousK + score - 1], previousY = previousX - previousK;
    const fromX = previousX + (move !== 2), fromY = previousY + (move !== 1);
    if (x > fromX) reversed.push({ html: a.slice(fromX, x).join(''), pdf: b.slice(fromY, x - k).join(''), changed: false });
    reversed.push({ html: move === 2 ? '' : a[previousX], pdf: move === 1 ? '' : b[previousY], changed: true });
    x = previousX; k = previousK;
  }
  const parts = failed ? [{ html: originalA.join(''), pdf: originalB.join(''), changed: true }] : [];
  if (!failed) appendPart(parts, originalA.slice(0, start).join(''), originalB.slice(0, start).join(''), false);
  for (const part of reversed.reverse()) appendPart(parts, part.html, part.pdf, part.changed);
  if (!failed) appendPart(parts, originalA.slice(endA).join(''), originalB.slice(endB).join(''), false);
  if (!wordwise) return { distance, parts };
  const diff = { distance: 0, parts: [] };
  let html = '', pdf = '';
  for (let i = 0; i <= parts.length; i++) {
    const span = parts[i];
    html += span?.html || ''; pdf += span?.pdf || '';
    // Refine through punctuation-only matches instead of using them as word boundaries.
    if (span && !/[\p{L}\p{N}]/u.test((span.changed ? parts[i + 1] : span)?.html || '')) continue;
    const a = span ? html.trimEnd().length : html.length, b = span ? pdf.trimEnd().length : pdf.length;
    const next = localTextDiff(html.slice(0, a), pdf.slice(0, b), true, 128);
    diff.distance += next.distance;
    for (const part of next.parts) appendPart(diff.parts, part.html, part.pdf, part.changed);
    html = html.slice(a); pdf = pdf.slice(b);
    if (span && !span.changed) {
      let end = 0;
      while (end < html.length && end < pdf.length && html[end] === pdf[end]) end++;
      appendPart(diff.parts, html.slice(0, end), pdf.slice(0, end), false);
      html = html.slice(end); pdf = pdf.slice(end);
    }
  }
  return diff;
}
function changedRange(before, after, equal = (a, b) => a === b) {
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && equal(before[start], after[start])) start++;
  while (oldEnd > start && newEnd > start && equal(before[oldEnd - 1], after[newEnd - 1])) { oldEnd--; newEnd--; }
  return { start, oldEnd, newEnd };
}
function appendPart(parts, html, pdf, changed) {
  const last = parts.at(-1), previous = parts.at(-2);
  if (changed && !pdf && last?.changed === false && previous?.changed && !previous.pdf && /^[\p{L}\p{N}]+$/u.test(last.html) && html.endsWith(last.html)) previous.html += last.html + html.slice(0, -last.html.length);
  else if (last?.changed === changed) { last.html += html; last.pdf += pdf; }
  else if (html || pdf) parts.push({ html, pdf, changed });
}
function normalized(raw, result = { text: "", starts: [], ends: [] }, base = 0, foldCase = true) {
  let previous = result.text.at(-1) || "";
  const units = [], { starts, ends } = result;
  for (const match of raw.matchAll(/((?<=[\p{L}\p{N}])[-\u2010\u2011]\s*\n\s*(?=[\p{L}\p{N}]))|([a-zA-Z0-9]+)|(\s+)|(\.(?:\s*\.){2,})|[\s\S]/gu)) {
    const char = match[0], start = base + match.index, offset = start + char.length;
    if (match[1] || char === "\u00ad") continue;
    if (match[2]) {
      units.push(foldCase ? char.toLowerCase() : char); previous = char.at(-1);
      for (let i = 0; i < char.length; i++) { starts.push(start + i); ends.push(start + i + 1); }
      continue;
    }
    const value = match[3] ? ' ' : match[4] ? char.replace(/\s/g, '') : char >= '!' && char <= '~' ? char : char.normalize("NFKC").replace(/ſ/g, "s").replace(/ß/g, "ss").replace(/ẞ/g, "SS")
      .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/\s/g, " ");
    for (const unit of foldCase ? value.toLowerCase() : value) {
      if (unit === " " && previous === " ") { ends[ends.length - 1] = offset; continue; }
      units.push(unit); previous = unit;
      for (let i = 0; i < unit.length; i++) { starts.push(start); ends.push(offset); }
    }
  }
  result.text += units.join("");
  return result;
}
function lowerBound(values, value, key = entry => entry) {
  let low = 0, high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (key(values[mid]) < value) low = mid + 1; else high = mid;
  }
  return low;
}
function htmlFontDefinition(name, text, rawStart, openStart) {
  const style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(text);
  const declarations = style ? style[1] ?? style[2] : '';
  const italic = /(?:^|;)\s*font-style\s*:\s*([^;!]+)/i.exec(declarations)?.[1].trim();
  const bold = /(?:^|;)\s*font-weight\s*:\s*([^;!]+)/i.exec(declarations)?.[1].trim();
  return { name, opening: text, rawStart, openStart, openEnd: openStart + text.length,
    italic: italic && /^(normal|italic|oblique)\b/i.test(italic) ? !/^normal$/i.test(italic) : /^(i|em)$/.test(name) ? true : null,
    bold: bold && /^(normal|bold|[1-9]00)$/i.test(bold) ? /bold/i.test(bold) || Number(bold) >= 600 : /^(b|strong)$/.test(name) ? true : null };
}
// Text indexing, matching and confirmed HTML/PDF range alignment.
function extendPageRange(from, to, a, x, step, exact = false, word = /^[\p{L}\p{N}\p{Pd}]{2}$/u) {
  const offset = step < 0 ? -1 : 0;
  // Only the first pass may cross a missing space when the next glyph matches.
  while (a + offset >= 0 && a + offset < from.length && x + offset >= 0 && x + offset < to.length) {
    const left = from[a + offset], right = to[x + offset];
    if (left !== right && (exact || !(left === ' ' && from[a + offset + step] === right)
      && !(right === ' ' && to[x + offset + step] === left))) break;
    if (left === right || left === ' ') a += step;
    if (left === right || right === ' ') x += step;
  }
  if (exact) return [a, x];
  // Keep OCR errors, dotted initials and wrapped compounds inside the same confirmed word.
  let aa = a, xx = x;
  while (aa > 0 && aa < from.length && Math.abs(a - aa) < 32 && word.test(from.slice(aa - 1, aa + 1))) aa += step;
  while (xx > 0 && xx < to.length && Math.abs(x - xx) < 32 && word.test(to.slice(xx - 1, xx + 1))) xx += step;
  if ((a !== aa || x !== xx) && !/[\p{L}\p{N}\p{Pd}]/u.test(from[aa + offset] || '')
    && !/[\p{L}\p{N}\p{Pd}]/u.test(to[xx + offset] || '')
    && textDiff(from.slice(Math.min(a, aa), Math.max(a, aa)), to.slice(Math.min(x, xx), Math.max(x, xx)), false, 32).distance <= 32) { a = aa; x = xx; }
  return extendPageRange(from, to, a, x, step, true, word);
}
class PdfSourceIndex {
  connections = new WeakMap();
  pageScopes = new WeakMap();
  preparation = null;
  constructor(locator, values) {
    Object.assign(this, { locator }, values);
    this.normalized ||= normalized(this.raw);
  }
  get differences() {
    const pdf = this.locator.environment.getPdf?.();
    const index = this.model && this.locator.editorSourceIndex(this.model, pdf && pdf !== this.preparation?.pdf ? undefined : this.targets);
    if (index && index !== this) return index.differences;
    const connections = this.diff(), data = this.preparation;
    const versions = [this.formats, ...data.pages.flatMap(page => [page.parts, page.pages, page.fontVersion])];
    if (!data.differences || versions.some((version, i) => version !== data.fontVersions[i])) {
      data.differences = { index: this, connections,
        items: this.reviewCandidates(data.pages, null, connections, true, true, true, true) };
      data.fontVersions = versions;
    }
    return data.differences;
  }
  // File-wide diff state; consumers refresh it by reading differences.
  diff(pages = this.targets || [], pdf = this.locator.environment.getPdf?.() || this.preparation?.pdf) {
    this.targets = pages;
    pages = [...new Set([...pages, ...(this.locator.environment.getTargets?.() || [])])].filter(Boolean);
    const full = this.locator.getDocumentIndex(pdf, this.locator.environment.getSourcePages?.());
    const prepared = this.preparation;
    if (prepared && prepared.pdf === pdf && prepared.full === full && prepared.pages?.length === pages.length
      && pages.every((page, i) => page === prepared.pages[i] && this.connections.get(page) === prepared.connections[i])) return prepared.pairs;
    if (full && !full.sourcePages && prepared?.document !== full) full.sourcePageScope(this, true);
    for (const page of new Set([full, ...pages])) if (page && page !== prepared?.document) this.sourcePageScope(page, true);
    // Prefer whole-passage mappings over shorter quotations on adjacent pages.
    const connections = this.connectionPairs(pages, true);
    for (const page of pages) {
      const previous = this.connections.get(page) || [];
      const retain = item => page.pages || !connections.some(([other, target]) => target !== page
        // Keep extracted mappings across rendered-layer disposal, and retain rendered fonts.
        && !target.pages
        && other.start <= item.start && other.end >= item.end
        && other.end - other.start > item.end - item.start);
      const retained = previous.filter(retain), scope = this.pageScopes.get(page);
      if (scope?.connections) scope.connections = scope.connections === previous ? retained : scope.connections.filter(retain);
      if (retained.length !== previous.length) this.connections.set(page, retained);
    }
    const pairs = this.connectionPairs(pages, true).map(([connection, target]) => [connection, target, this.connectionDiff(target, connection)]);
    this.preparation = { pdf, full, document: full || prepared?.document, pages, connections: pages.map(page => this.connections.get(page)), pairs };
    return pairs;
  }
  connectionPairs(targets = [], prepared = false) {
    // Default marks keep their prepared diff while selections update the live mapping cache.
    return targets.filter(Boolean).flatMap(target => (prepared && this.pageScopes.get(target)?.connections || this.connections.get(target) || []).map(connection => [connection, target]))
      .sort(([, x], [, y]) => Number(!!x.pages) - Number(!!y.pages) || Number(!!y.layer) - Number(!!x.layer));
  }
  // Shared range preparation for connections, selections and missing text.
  connectionDiff(target, connection, diff = connection?.editorDiff) {
    diff ||= connection.editorDiff = textDiff(this.raw.slice(connection.start, connection.end),
      target.raw.slice(connection.targetStart, connection.targetEnd), true, Infinity, true);
    const context = [this.formats, target?.parts, target?.pages, target?.fontVersion], refreshText = !diff.context || diff.context[0] !== this.formats;
    if (diff.context?.every((value, i) => value === context[i])) return diff.reliable ? diff : null;
    let left = 0, right = 0;
    diff.ranges ||= (diff.parts || []).map(part => [left, left += part.html.length, right, right += part.pdf.length,
      { ...part, significant: [significantText(part.html), significantText(part.pdf)], blank: [!part.html.trim(), !part.pdf.trim()] }]);
    Object.assign(diff, { context, reliable: true, projection: diff.projection || diff.ranges.filter(range => range[2] < range[3]),
      textRanges: refreshText ? [] : diff.textRanges, fontItems: [] });
    const runs = this.formats && target ? target.fontRuns(connection.targetStart, connection.targetEnd) : [];
    for (const range of connection ? diff.ranges : []) {
      const [a, b, from, to, part] = range;
      const [html, pdf] = part.significant, start = connection.start + a, pdfStart = connection.targetStart + from, pdfEnd = connection.targetStart + to;
      if (refreshText && part.changed && (/\d/.test(part.html) ? significantText(part.html, this, start) : html) !== pdf) diff.textRanges.push(range);
      if (!(diff.distance <= 128) && part.changed && html !== pdf && Math.max(html.length, pdf.length) > 128) diff.reliable = false;
      let compared = runs.slice(lowerBound(runs, pdfStart + Number(from < to), font => font.end),
        lowerBound(runs, pdfEnd + Number(from === to), font => font.start));
      if (part.changed && compared.length) {
        const font = { ...compared[0], start: pdfStart, end: pdfEnd };
        for (const key of ['italic', 'bold']) if (!compared.every(value => value[key] === font[key])) font[key] = null;
        compared = [font];
      }
      for (const font of compared) {
        let at = part.changed ? start : start + Math.max(pdfStart, font.start) - pdfStart;
        const end = part.changed ? connection.start + b : start + Math.min(pdfEnd, font.end) - pdfStart;
        while (at < end) {
          const htmlFont = this.formats[at];
          let stop = at + 1;
          while (stop < end && this.formats[stop] === htmlFont) stop++;
          if (htmlFont && ['italic', 'bold'].some(key => typeof font[key] === 'boolean' && font[key] !== htmlFont[key])) {
            const text = this.raw.slice(at, stop), sourceStart = at + (text.match(/^\s*/)?.[0].length || 0),
              sourceEnd = stop - (text.match(/\s*$/)?.[0].length || 0);
            if (sourceStart < sourceEnd) diff.fontItems.push({ sourceStart, sourceEnd, font, htmlFont });
          }
          at = stop;
        }
      }
    }
    return diff.reliable ? diff : null;
  }
  missingRange(target, start, end, selectionStart = start, selectionEnd = end) {
    const ordered = (this.connections.get(target) || []).toSorted((a, b) => a.start - b.start);
    const before = ordered.findLast(c => c.end <= start), after = ordered.find(c => c.start >= end);
    if (!before && !after) return null;
    const a = before ? this.connectedRange(target, selectionStart, before.end)?.start ?? before.targetEnd : 0;
    const b = after ? this.connectedRange(target, after.start, selectionEnd)?.end ?? after.targetStart : target.raw.length;
    return b < a ? null : { start: a, end: target.raw.slice(a, b).trim() ? b : a, endBias: !!before };
  }
  reviewCandidates(targets = [], notice = null, connections = this.connectionPairs(targets, true), edits = true, fonts = false, text = true, update = false) {
    if (!update && !notice && connections === this.preparation?.pairs)
      return this.formatDifferences(connections, edits, fonts, this.differences.items.filter(item => item.font || text));
    const items = [];
    const add = (start, diff, pdfRaw = '', pdfStart = 0, connection = null, missing = false) => {
      if (!diff) return;
      const ranges = (connection ? diff : this.connectionDiff(null, null, diff)).ranges;
      const projection = diff.projection;
      const project = (offset, endBias) => {
        offset -= pdfStart;
        const hit = projection[lowerBound(projection, offset, range => range[3])];
        if (!hit) return start + (ranges.at(-1)?.[1] || 0);
        const [a, b, from, to, part] = hit;
        return start + (!part.changed ? a + Math.max(0, offset - from)
          : offset <= from ? a : endBias || offset === to ? b : a);
      };
      for (const [a, b, targetStart, , part] of connection ? diff.textRanges : ranges) {
        const from = start + a, end = start + b, at = pdfStart + targetStart;
        // Explicit review selections retain footnote digits suppressed in default comparisons.
        if ((connection || part.changed && significantText(part.html, !notice ? this : null, from) !== significantText(part.pdf))
          && (!connection || connections.find(([other]) => other === connection || other.start <= from && other.end >= end
            && (from < end || other.end > from || other.start === from))?.[0] === connection)) {
          const low = lowerBound(items, from, item => item.sourceStart);
          if (items[low]?.sourceStart === from || low && items[low - 1].sourceEnd > from
            || items[low] && items[low].sourceStart < end && items[low].sourceEnd > from) continue;
          const lineStart = pdfRaw.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
          const nextLine = pdfRaw.indexOf('\n', at + part.pdf.length);
          const lineEnd = nextLine < 0 ? pdfRaw.length : nextLine;
          let a = pdfRaw ? Math.min(from, project(lineStart, false)) : this.raw.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
          let b = pdfRaw ? Math.max(end, project(lineEnd, true)) : this.raw.indexOf('\n', end);
          a = Math.max(0, a);
          b = b < 0 ? this.raw.length : Math.min(this.raw.length, b);
          const before = this.raw.slice(a, from), after = this.raw.slice(end, b);
          const preview = { html: this.raw.slice(a, b), pdf: before + part.pdf + after };
          this.locator.comparisonParts(preview, [{ html: before, pdf: before, changed: false }, part, { html: after, pdf: after, changed: false }]);
          items.splice(low, 0, {
            id: `${from}:${end}`, sourceStart: from, sourceEnd: end, preview, ...(missing ? { missing: true } : {}),
            comparison: { html: part.html, pdf: part.pdf }, options: [
              { id: 'pdf', label: '替换', edits: edits && !missing
                && !(this.starts?.[from] < this.ends?.[from - 1] || this.starts?.[end] < this.ends?.[end - 1])
                ? this.textEdits(from, end, part.pdf) : [] }
            ]
          });
        }
      }
    };
    for (const [connection, target, diff] of text ? connections : [])
      add(connection.start, this.connectionDiff(target, connection, diff), target.raw, connection.targetStart, connection);
    if (text && notice?.source && this.raw.slice(notice.source.start, notice.source.end) === notice.html)
      add(notice.source.start, { parts: this.locator.comparisonParts(notice) });
    // Missing text is the significant remainder outside confirmed OCR mappings.
    const target = text && (targets.length ? targets : connections.map(([, target]) => target)).find(target => target?.sourcePages?.length);
    if (target && (this.pageScopes.get(target)?.prepared || connections.some(([connection, index]) => index === target && connection.recovered))) {
      const ordered = connections.flatMap(([connection, index]) => (index === target || index.layer)
        && this.connectionDiff(index, connection) ? [connection] : []).sort((a, b) => a.start - b.start);
      let start = this.raw.length - this.raw.trimStart().length;
      for (const range of [...ordered, { start: this.raw.trimEnd().length }]) {
        if (range.start > start) add(start, { parts: [{ html: this.raw.slice(start, range.start), pdf: '', changed: true }] }, '', 0, null, true);
        start = Math.max(start, range.end ?? range.start);
      }
    }
    return this.formatDifferences(connections, edits, fonts, items);
  }

  fontRuns(start = 0, end = this.raw.length, nodes = false) {
    const runs = [];
    const first = this.parts && Math.min(this.parts.length - 1, lowerBound(this.parts, start + 1, part => part.end));
    const parts = this.parts ? this.parts.slice(first, (start === end ? first : lowerBound(this.parts, end, part => part.end)) + 1)
      : this.pages?.filter(page => start < page.end && end > page.start).flatMap(page => page.parts) || [];
    if (nodes) return parts;
    for (const part of parts) {
      const a = Math.max(start, part.start), b = Math.min(end, part.end);
      if (a >= b || !this.raw.slice(a, b).trim()) continue;
      const style = part.font || { name: '', italic: null, bold: null }, last = runs.at(-1);
      if (last && last.italic === style.italic && last.bold === style.bold && last.name === style.name
        && !this.raw.slice(last.end, a).trim()) last.end = b;
      else runs.push({ ...style, start: a, end: b });
    }
    return runs;
  }
  fontEdits(start, end, font) {
    while (start < end && /\s/u.test(this.raw[start])) start++;
    while (end > start && /\s/u.test(this.raw[end - 1])) end--;
    if (start >= end) return [];
    const styles = this.formats.slice(start, end), keys = ['italic', 'bold'].filter(key => typeof font[key] === 'boolean'
      && styles.some((style, i) => !/\s/u.test(this.raw[start + i])
        && (style[key] !== font[key] || !font[key] && style.tags?.some(tag => typeof tag[key] === 'boolean'))));
    if (!keys.length) return [];
    const tags = [...new Set(styles.flatMap(style => style.tags || []))]
      .filter(tag => keys.some(key => typeof tag[key] === 'boolean'))
      .sort((a, b) => a.openStart - b.openStart);
    if (tags.some(tag => tag.closeStart === undefined || !['i', 'em', 'b', 'strong', 'span'].includes(tag.name))) return [];
    // Move adjacent boundaries when adding a single format to unwrapped text.
    if (!tags.length && keys.length === 1 && font[keys[0]]) {
      const key = keys[0], opening = key === 'italic' ? /^<(i|em)>$/i : /^<(b|strong)>$/i;
      const adjacent = before => {
        let at = before ? start - 1 : end;
        while (at >= 0 && at < this.raw.length && /[^\S\r\n]/u.test(this.raw[at])) at += before ? -1 : 1;
        return this.formats[at]?.tags?.findLast(tag => tag[key] === true
          && opening.test(tag.opening)
          && tag.closeStart !== undefined && (before ? tag.rawEnd <= start : tag.rawStart >= end)
          && /^[^\S\r\n]*$/u.test(this.source.slice(before ? tag.closeEnd : this.ends[end - 1],
            before ? this.starts[start] : tag.openStart)));
      };
      const left = adjacent(true), candidate = adjacent(false);
      const right = candidate && (!left || candidate.opening === left.opening) ? candidate : null;
      if (left || right) {
        const a = left ? left.closeStart : this.starts[start], b = right ? right.openEnd : this.ends[end - 1];
        const text = (left ? this.source.slice(left.closeEnd, this.starts[start]) : right.opening)
          + this.source.slice(this.starts[start], this.ends[end - 1])
          + (right ? this.source.slice(this.ends[end - 1], right.openStart) : left.closing);
        return [{ start: a, end: b, expected: this.source.slice(a, b), text }];
      }
    }
    let a = this.starts[start], b = this.ends[end - 1];
    // Include complete wrappers, including whitespace at their edges.
    for (const tag of tags) {
      if (!this.raw.slice(tag.rawStart, start).trim()) a = Math.min(a, tag.openStart);
      if (!this.raw.slice(end, tag.rawEnd).trim()) b = Math.max(b, tag.closeEnd);
    }
    const removed = tags.flatMap(tag => [[tag.openStart, tag.openEnd], [tag.closeStart, tag.closeEnd]])
      .filter(([start, end]) => start >= a && end <= b).sort(([a], [b]) => b - a);
    let cursor = a;
    const strip = to => {
      const pieces = [];
      while (removed.length && removed.at(-1)[1] <= to) {
        const [start, end] = removed.pop();
        pieces.push(this.source.slice(cursor, start)); cursor = end;
      }
      pieces.push(this.source.slice(cursor, to)); cursor = to;
      return pieces.join('');
    };
    // Use source coordinates so whitespace entities also stay outside the tags.
    const leading = strip(this.starts[start]);
    let text = strip(this.ends[end - 1]);
    const trailing = strip(b);
    for (const key of keys) if (font[key]) {
      const name = key === 'italic' ? 'i' : 'b';
      text = `<${name}>${text}</${name}>`;
    }
    text = leading + text + trailing;
    // Keep the portions of enclosing wrappers outside the selected words.
    let left = '', right = '';
    for (const tag of tags) {
      if (tag.openStart < a) left = tag.closing + left;
      if (tag.closeEnd > b) right += tag.opening;
    }
    if (left) { const space = this.source.slice(0, a).match(/\s*$/u)[0]; a -= space.length; text = left + space + text; }
    if (right) { const space = this.source.slice(b).match(/^\s*/u)[0]; b += space.length; text += space + right; }
    return [{ start: a, end: b, expected: this.source.slice(a, b), text }];
  }
  // Reuse text alignment; changed spans require agreement on each PDF style.
  formatDifferences(connections, edits = true, keys = ['italic', 'bold'], candidates = []) {
    keys = keys === true ? ['italic', 'bold'] : keys || [];
    if (keys.length === 2 && candidates.some(item => item.font)) return candidates;
    if (keys.length !== 2) candidates = candidates.filter(item => !item.font);
    if (!this.formats || !keys.length) return candidates;
    const items = new Map();
    for (const [connection, target, diff] of connections)
      for (const item of this.connectionDiff(target, connection, diff)?.fontItems || []) {
        const font = { ...item.font }, id = `font:${item.sourceStart}:${item.sourceEnd}`;
        for (const key of ['italic', 'bold']) if (!keys.includes(key)) font[key] = null;
        if (!items.has(id) && keys.some(key => typeof font[key] === 'boolean' && font[key] !== item.htmlFont[key]))
          items.set(id, { ...item, font, formats: [{ font, htmlFont: item.htmlFont }] });
      }
    // Merge adjacent format changes, or bridge punctuation with the same mismatch.
    const first = candidates.length;
    for (const item of [...items.values()].sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd)) {
      const previous = candidates.length > first && candidates.at(-1), gap = previous && this.raw.slice(previous.sourceEnd, item.sourceStart);
      const joins = previous && item.sourceStart >= previous.sourceEnd && !/[\r\n]/.test(gap)
        && previous.htmlFont.tags === item.htmlFont.tags
        && ['italic', 'bold'].every(key => previous.font[key] === item.font[key] && previous.htmlFont[key] === item.htmlFont[key])
        && (!gap.trim() || !(/\s/u.test(gap) && /[\p{L}\p{N}]/u.test(gap)) && ['italic', 'bold'].some(key =>
          typeof previous.font[key] === 'boolean'
          && this.formats.slice(previous.sourceEnd, item.sourceStart).every((style, i) =>
            /\s/u.test(gap[i]) || (style && style[key] !== previous.font[key]))));
      if (!joins) { candidates.push(item); continue; }
      previous.sourceEnd = item.sourceEnd;
      previous.formats.push(...item.formats);
    }
    const text = candidates.slice(0, first);
    for (const item of candidates.slice(first)) {
      Object.assign(item, { id: `font:${item.sourceStart}:${item.sourceEnd}`, text: this.raw.slice(item.sourceStart, item.sourceEnd),
        options: edits ? [{ id: 'format', edits: this.fontEdits(item.sourceStart, item.sourceEnd, item.font) }] : [] });
      const nearby = text[lowerBound(text, item.sourceStart, range => range.sourceEnd)];
      item.reviewStart = nearby && nearby.sourceStart <= item.sourceEnd ? nearby.sourceStart : item.sourceStart;
    }
    return candidates.sort((a, b) => (a.reviewStart ?? a.sourceStart) - (b.reviewStart ?? b.sourceStart) || Number(!!a.font) - Number(!!b.font));
  }
  sourceSegments(start, end, includeWhitespace = false) {
    const segments = [];
    for (let at = start; at < end; at++) {
      const a = this.starts[at], b = this.ends[at], last = segments.at(-1);
      const text = this.source?.slice(a, b);
      if (/^</.test(text) || !includeWhitespace && /^\s*$/.test(text)) continue;
      if (last && a <= last.end) last.end = Math.max(last.end, b);
      else segments.push({ start: a, end: b });
    }
    return segments;
  }
  sourceDecorations(connections, model, fonts = true, text = true, targets = connections.map(([, target]) => target), items, hover) {
    items ||= this.reviewCandidates(targets, null, connections, false, fonts, text);
    const decorations = [];
    for (const item of items) {
      if (item.font ? !fonts : !text) continue;
      const font = !item.comparison, start = !font && !item.comparison.html.trim() && /^\s/u.test(item.comparison.pdf) ? item.sourceEnd : item.sourceStart;
      const options = {
        description: font ? 'PDF font difference' : 'PDF OCR text difference',
        linesDecorationsClassName: 'mew-ocr-diff-line', stickiness: 1,
        inlineClassName: font ? 'mew-font-diff-text' : 'mew-ocr-diff-text',
        hoverMessage: hover?.(item),
        linesDecorationsTooltip: font ? '粗体／斜体与 PDF 不一致' : 'Text differs from PDF OCR'
      };
      const segments = this.sourceSegments(start, item.sourceEnd, font || !this.raw.slice(start, item.sourceEnd).trim());
      if (!font && !segments.length) {
        const at = this.starts[start] ?? this.ends[start - 1] ?? 0;
        segments.push({ start: at, end: at });
        Object.assign(options, { inlineClassName: undefined, showIfCollapsed: true,
          before: { content: '\u200b', inlineClassName: 'mew-ocr-diff-insert', inlineClassNameAffectsLetterSpacing: true } });
      }
      for (const { start, end } of segments) decorations.push({ range: rangeAt(model, start, end), options });
    }
    return decorations.sort(({ range: a }, { range: b }) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn
      || b.endLineNumber - a.endLineNumber || b.endColumn - a.endColumn);
  }
  textEdits(start, end, replacement) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start
      || end > this.raw.length || typeof replacement !== 'string') throw new Error('无效的可见文字替换范围');
    const segments = this.sourceSegments(start, end, !this.raw.slice(start, end).trim());
    if (!segments.length) {
      const at = this.starts[start] ?? this.ends[start - 1] ?? 0;
      segments.push({ start: at, end: at });
    }
    const text = replacement.replace(/[&<>]/g, char => char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;');
    return segments.map((segment, i) => ({ ...segment, text: i ? '' : text,
      expected: this.source.slice(segment.start, segment.end) }));
  }
  sourcePageScope(page, connect = false) {
    const cached = this.pageScopes.get(page);
    if (cached && (!connect || cached.prepared)) return cached.scope;
    const from = page.normalized, to = this.normalized, text = from.text;
    const reverse = connect && page.connections?.get(this);
    for (const item of reverse || []) this.rememberConnection(item.targetStart, item.targetEnd, page, { start: item.start, end: item.end }, {
      diff: { distance: item.distance, parts: item.spans.map(span => ({ html: span.pdf, pdf: span.html, changed: span.changed })) }
    });
    const connection = reverse?.length ? { start: Math.min(...reverse.map(item => item.targetStart)), end: Math.max(...reverse.map(item => item.targetEnd)) }
      : (this.connections.get(page) || []).find(item => item.targetStart === 0 && item.targetEnd === page.raw.length)
        || connect && (page.sourcePages?.length || page.layer) && this.rememberConnection(0, this.raw.length, page, { start: 0, end: page.raw.length }, { recover: true });
    const matches = cached?.matches || { 0: connection ? [] : this.matches([page.raw]) };
    let scope = connection || (matches[0].length === 1 ? matches[0][0] : null);
    if (scope && connect && !connection) scope = this.rememberConnection(scope.start, scope.end, page, { start: 0, end: page.raw.length }) || scope;
    for (let prepare = Number(connect); !scope && prepare >= 0; prepare--) {
      const size = Math.min(prepare ? 24 : 96, text.length);
      // Overlap prepared anchors so nearby OCR errors cannot hide a clean passage between samples.
      const anchors = !this.connections.has(page) && matches[size] || (matches[size] = size < 24 ? [] : this.matches([text], to, { sample: size, step: prepare ? 8 : 0, anchors: prepare && !this.locator.options.wholeWords, page }));
      if (prepare) {
        const confirmed = [];
        for (let i = 1; i < anchors.length; i++) {
          const a = anchors[i - 1], b = anchors[i], previous = confirmed.at(-1);
          const left = text.slice(a.at, b.at + size), right = to.text.slice(a.start, b.end);
          const limit = Math.min(32, Math.max(12, Math.floor(left.length * .2)));
          if (b.start <= a.start || left.length > 2048 || textDiff(left, right, false, limit).distance > limit) continue;
          // Use the connection budget on the union: overlapping samples must not count the same OCR errors twice.
          if (!previous || previous.b < a.at || previous.y < a.start
            || textDiff(text.slice(previous.a, b.at + size), to.text.slice(previous.x, b.end), false, 128).distance > 128)
            confirmed.push({ a: a.at, x: a.start });
          Object.assign(confirmed.at(-1), { b: b.at + size, y: b.end });
        }
        let previous = null;
        for (const range of confirmed) {
          let [a, x] = extendPageRange(text, to.text, range.a, range.x, -1);
          const aa = lowerBound(from.starts, page.raw.lastIndexOf('\n', from.starts[a] - 1) + 1);
          const xx = lowerBound(to.starts, this.raw.lastIndexOf('\n', to.starts[x] - 1) + 1);
          if (a > aa && x > xx && a - aa <= 32 && x - xx <= 32
            && /[\p{L}\p{N}]/u.test(to.text.slice(xx, x))
            && (!/\p{L}/u.test(text.slice(aa, a)) || /\p{L}/u.test(to.text.slice(xx, x)))
            && !/[\r\n]/.test(page.raw.slice(from.starts[a], from.ends[a]) + this.raw.slice(to.starts[x], to.ends[x]))) [a, x] = [aa, xx];
          const [b, y] = extendPageRange(text, to.text, range.b, range.y, 1);
          // Edge expansion can make adjacent anchor groups overlap. Compare their union
          // so a joined OCR word is not counted twice and selections can cross the seam.
          const merged = previous && (previous.end <= to.starts[x] && previous.targetEnd > from.starts[a]
            || previous.end > to.starts[x] && previous.targetEnd === from.starts[a])
            && this.rememberConnection(previous.start, Math.max(previous.end, to.ends[y - 1]), page,
              { start: previous.targetStart, end: Math.max(previous.targetEnd, from.ends[b - 1]) });
          if (merged) this.connections.set(page, this.connections.get(page).filter(item => item !== previous));
          if (previous ? previous.end < to.starts[x] && previous.targetEnd < from.starts[a]
            : page.sourcePages?.length && to.starts[x] <= 2048)
            this.rememberConnection(previous?.end ?? this.raw.length - this.raw.trimStart().length, to.starts[x], page,
              { start: previous?.targetEnd ?? 0, end: from.starts[a] }, { recover: !!(page.sourcePages?.length || page.layer) });
          previous = merged || this.rememberConnection(to.starts[x], to.ends[y - 1], page, { start: from.starts[a], end: from.ends[b - 1] });
        }
        if (page.sourcePages?.length && previous && this.raw.length - previous.end <= 2048 && significantText(this.raw.slice(previous.end)))
          this.rememberConnection(previous.end, this.raw.trimEnd().length, page, { start: previous.targetEnd, end: page.raw.trimEnd().length }, { recover: true });
      }
      if (anchors.length < 2 || !anchors.every((anchor, i) => !i || anchor.start > anchors[i - 1].start)) continue;
      const first = anchors[0], last = anchors.at(-1);
      const start = Math.max(0, first.start - first.at - 32), end = Math.min(to.text.length, last.end + text.length - last.at - size + 32);
      // Context padding must stay within the PDF pages confirmed by the anchors.
      const firstPage = this.pages?.find(page => to.starts[first.start] >= page.start && to.starts[first.start] < page.end);
      const lastPage = this.pages?.find(page => to.starts[last.end - 1] >= page.start && to.starts[last.end - 1] <= page.end);
      scope = { start: Math.max(to.starts[start], firstPage?.start ?? 0), end: Math.min(to.ends[end - 1], lastPage?.end ?? this.raw.length) };
    }
    this.pageScopes.set(page, { scope, matches, prepared: connect, connections: connect ? this.connections.get(page) || [] : undefined });
    return scope;
  }
  *matchPositions(needle, { text }, anchors) {
    if (!anchors || text.length < 65536) {
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) yield at;
      return;
    }
    // Index aligned 8-character blocks so short anchors also avoid full-volume rescans.
    this.anchorBlocks ||= Map.groupBy(Array.from({ length: Math.floor(text.length / 8) }, (_, i) => i * 8),
      at => text.slice(at, at + 8));
    for (let offset = 0; offset < 8 && offset + 8 <= needle.length; offset++) {
      for (const position of this.anchorBlocks.get(needle.slice(offset, offset + 8)) || []) {
        const at = position - offset;
        if (at >= 0 && text.startsWith(needle, at)) yield at;
      }
    }
  }
  matches(queries, haystack = this.normalized, { anchors = false, sample = 0, step = 0, fuzzy = false, before = '', after = '', page } = {}) {
    // Sample each anchor independently; only its unique hit can establish page order.
    if (sample) return queries.flatMap(query => [...new Set(step
      ? Array.from({ length: Math.ceil((query.length - sample) / step) + 1 }, (_, i) => Math.min(i * step, query.length - sample))
      : [0, .25, .5, .75, 1].map(ratio => Math.floor((query.length - sample) * ratio)))].flatMap(at => {
      const start = page?.normalized.starts[at], end = page?.normalized.ends[at + sample - 1];
      const connection = (page && this.connections.get(page) || []).find(item => item.targetStart <= start && item.targetEnd >= end);
      const hit = connection && this.connectedRange(page, start, end, true, connection);
      const hits = hit && !hit.approximate ? [hit] : this.matches([query.slice(at, at + sample)], haystack, { anchors });
      return hits.length === 1 ? [{ at, start: lowerBound(haystack.starts, hits[0].start), end: lowerBound(haystack.starts, hits[0].end) }] : [];
    }));
    const found = new Map(), word = char => !!char && /[\p{L}\p{N}_]/u.test(char);
    for (const query of queries) {
      const needle = anchors ? query : normalized(query).text.trim();
      if (fuzzy) {
        const size = [...needle].length, long = needle.length > 128;
        if (size && size < 3 || !size && (before.length < 4 || after.length < 4) || needle.length > 2048 || before.length + after.length < 8 || (long && (before.length < 12 || after.length < 12))) return [];
        const limit = !size ? 0 : long ? Math.min(32, Math.max(3, Math.floor(size * 0.05)))
          : Math.min(3, Math.max(1, Math.floor(size * 0.2)));
        const starts = new Set(), ends = new Set(), text = haystack.text;
        for (const [context, left] of [[before, true], [after, false]]) {
          if (context.length < 4) continue;
          for (const size of [...new Set([Math.min(24, context.length), Math.min(12, context.length), ...(long ? [] : [4])])]) {
            const anchor = left ? context.slice(-size) : context.slice(0, size);
            let anchored = false;
            for (const at of this.matchPositions(anchor, haystack)) {
              anchored = true;
              let boundary = left ? at + anchor.length : at;
              if (left) {
                while (text[boundary] === ' ') boundary++;
                starts.add(boundary);
              } else {
                while (boundary && text[boundary - 1] === ' ') boundary--;
                if (long) ends.add(boundary);
                else for (let delta = -limit; delta <= limit; delta++) starts.add(boundary - needle.length + delta);
              }
              if (starts.size > 200 || ends.size > 200) return [];
            }
            if (anchored) break;
          }
        }
        for (const begin of starts) for (const end of long ? ends : Array.from({ length: limit * 2 + 1 }, (_, i) => begin + needle.length - limit + i)) {
          if (Math.abs(end - begin - needle.length) > limit
            || begin < 0 || end > text.length || text[begin] === ' ' || text[end - 1] === ' ') continue;
          // Never cut a normalized glyph (e.g. a ligature or a surrogate pair).
          if ((begin && haystack.starts[begin] === haystack.starts[begin - 1]) || (end < text.length && haystack.starts[end] === haystack.starts[end - 1])) continue;
          const distance = textDiff(needle, text.slice(begin, end), false, limit).distance;
          if (size && !distance || distance > limit) continue;
          const start = haystack.starts[begin], stop = size ? haystack.ends[end - 1] : start;
          found.set(`${start}:${stop}`, { start, end: stop, approximate: true, distance });
        }
      } else if (needle) {
        for (const at of this.matchPositions(needle, haystack, anchors)) {
          const end = at + needle.length;
          const before = [...haystack.text.slice(Math.max(0, at - 2), at)].pop(), after = [...haystack.text.slice(end, end + 2)][0];
          if (this.locator.options.wholeWords && (word(needle[0]) && word(before) || word([...needle].pop()) && word(after))) continue;
          const start = haystack.starts[at], stop = haystack.ends[end - 1];
          found.set(`${start}:${stop}`, { start, end: stop });
          if (anchors && found.size > 1) return [...found.values()]; // Only unique anchors are useful.
        }
      }
    }
    return [...found.values()];
  }
  locate(entry, scope = null) {
    const offset = scope?.start || 0, haystack = scope ? scope.normalized ||= offset === 0 && scope.end === this.raw.length ? this.normalized : normalized(this.raw.slice(offset, scope.end)) : this.normalized;
    const before = normalized(entry.before).text.trim(), after = normalized(entry.after).text.trim();
    for (let fuzzy = 0; fuzzy < 2; fuzzy++) {
      const hits = this.matches([entry.text], haystack, { fuzzy: !!fuzzy, before, after });
      let best = null, tied = false;
      for (const hit of hits) {
        const begin = lowerBound(haystack.starts, hit.start), end = lowerBound(haystack.starts, hit.end);
        const left = haystack.text.slice(Math.max(0, begin - 400), begin).trim();
        const right = haystack.text.slice(end, end + 400).trim();
        let a = 0, b = 0;
        while (a < before.length && a < left.length && before.at(-a - 1) === left.at(-a - 1)) a++;
        while (b < after.length && b < right.length && after[b] === right[b]) b++;
        const score = a + b;
        if (!best || score > best.score) { best = { ...hit, score }; tied = false; }
        else if (score === best.score) tied = true;
      }
      if (!best || best.score < Math.min(24, before.length + after.length)) continue;
      return tied ? null : { ...best, start: best.start + offset, end: best.end + offset };
    }
    return null;
  }
  rememberConnection(start, end, target, hit, alignment) {
    if (start > end || hit.start > hit.end) return null;
    const cached = this.connections.get(target) || [];
    const existing = cached.find(item => item.start === start && item.end === end
      && item.targetStart === hit.start && item.targetEnd === hit.end);
    if (existing) return existing;
    const left = alignment?.left || (start === 0 && end === this.raw.length ? this.normalized : normalized(this.raw.slice(start, end))),
      right = alignment?.right || (hit.start === 0 && hit.end === target.raw.length ? target.normalized : normalized(target.raw.slice(hit.start, hit.end)));
    if (!left.text && !right.text) return null;
    const diff = alignment?.diff || textDiff(left.text, right.text, true);
    if (diff.distance > 128 && diff.parts.some(part => part.changed && Math.max(part.html.length, part.pdf.length) > 128)
      || alignment?.recover && diff.distance > 32 && !diff.parts.some(part => !part.changed && /[\p{L}\p{N}]{3}/u.test(part.html))) {
      if (!alignment?.recover) return null;
      // Recover word runs, keeping bounded OCR differences in the normal diff path.
      const words = text => text.match(left.text.includes('...') || right.text.includes('...') ? /\S+?\.(?=\.|\s|$)|\S+\s*|\s+/gu : /\S+\s*|\s+/gu) || [];
      const coarse = localTextDiff(words(left.text), words(right.text), true, 512, undefined, false);
      let a = 0, b = 0;
      for (const part of coarse.parts) {
        const x = a, y = b;
        a += part.html.length; b += part.pdf.length;
        if (!/[\p{L}\p{N}]{3}/u.test(part.html) || part.changed && !textDiff(part.html, part.pdf, true).parts
          .some(span => !span.changed && /[\p{L}\p{N}]{3}/u.test(span.html))) continue;
        const [bb, yy] = extendPageRange(left.text, right.text, a, b, 1, false, /^[\p{L}\p{N}\p{Pd}.]{2}$/u);
        const connection = this.rememberConnection(start + left.starts[x], start + left.ends[bb - 1], target,
          { start: hit.start + right.starts[y], end: hit.start + right.ends[yy - 1] });
        if (connection) connection.recovered = true;
      }
      return null;
    }
    const connection = { start, end, targetStart: hit.start, targetEnd: hit.end, normalized: left, distance: diff.distance, spans: diff.parts };
    this.connections.set(target, [connection, ...cached.filter(item => item.start !== start || item.end !== end)].slice(0, Math.max(16, this.raw.length)));
    return connection;
  }
  connectedRange(target, start, end, reverse = false, connection, marked = false) {
    if (start > end) return null;
    const side = Number(reverse), x = side * 2, y = 2 - x;
    const begin = reverse ? 'targetStart' : 'start', stop = reverse ? 'targetEnd' : 'end';
    let connections = connection ? [connection] : this.connections.get(target) || [];
    connection ||= start < end && connections.find(item => start >= item[begin] && end <= item[stop]);
    // Add bounded gap diffs between confirmed neighbours in the same ordered traversal.
    if (!connection && start < end) connections = [...connections].sort((a, b) => a[begin] - b[begin]).flatMap((b, i, ordered) => {
      const a = ordered[i - 1];
      const gap = a && a[stop] < Math.min(end, b[begin]) && b[begin] > start
        && a.end <= b.start && a.targetEnd <= b.targetStart
        && Math.max(b.start - a.end, b.targetStart - a.targetEnd) <= 2048
        && this.rememberConnection(a.end, b.start, target, { start: a.targetEnd, end: b.targetStart });
      if (gap && start >= gap[begin] && end <= gap[stop]) connection ||= gap;
      return gap ? [gap, b] : [b];
    });
    if (!connection && target.normalized && !this.pageScopes.get(target)?.prepared) {
      this.sourcePageScope(target, true);
      return this.connectedRange(target, start, end, reverse, connection, marked);
    }
    let first = Infinity, last = -1, covered = start;
    for (const item of connection ? [connection] : connections) {
      if (!connection && (start === end ? start < item[begin] || end > item[stop]
        : start >= item[stop] || end <= item[begin])) continue;
      const diff = this.connectionDiff(target, item);
      if (!diff) continue;
      if (item[begin] > covered) return null;
      covered = Math.max(covered, item[stop]);
      const a = start - item[begin], b = end - item[begin], offset = reverse ? item.start : item.targetStart;
      for (let i = lowerBound(diff.ranges, a, span => span[x + 1]); i < diff.ranges.length && diff.ranges[i][x] <= b; i++) {
        const range = diff.ranges[i], part = range[4], left = range[x], right = range[x + 1], targetLeft = range[y], targetRight = range[y + 1];
        if (a === b ? !part.changed || a < left || a > right || left !== right
          && !(marked && part.blank[side] && part.significant[1 - side])
          : left === right && part.significant[1 - side]
            ? left < a || left > b : right <= a || left >= b) continue;
        first = Math.min(first, offset + (part.changed ? targetLeft : targetLeft + Math.max(a, left) - left));
        last = Math.max(last, offset + (part.changed ? targetRight : targetLeft + Math.min(b, right) - left));
      }
      // An overlapping match may end here before the connection containing the insertion.
      if (start === end && last >= first) { connection = item; break; }
    }
    if (covered < end || last < first || last === first && reverse) return null;
    return { start: first, end: last, connection,
      approximate: significantText((reverse ? target : this).raw.slice(start, end)) !== significantText((reverse ? this : target).raw.slice(first, last)) };
  }
}
window.PdfSelectionDiff = {
  PdfSourceIndex, normalized, lowerBound, htmlFontDefinition, textDiff,
  validateEdits, previewEdits, applyEdits, rangeAt, significantText, changedRange,
  ready: import("/monaco/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js")
    .then(({ DefaultLinesDiffComputer }) => diffComputer = new DefaultLinesDiffComputer())
    .catch(() => null)
};
