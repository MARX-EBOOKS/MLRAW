"use strict";
let computer = null, monacoTask = null;
function fontSummary(runs) {
  const states = [], reasons = [...new Set(runs.map(run => run.reason).filter(Boolean))];
  for (const key of ['italic', 'bold']) {
    const values = new Set(runs.map(run => run[key]));
    const state = !values.size || values.has(null) ? '未知' : values.size > 1 ? '混合' : values.has(true) ? '是' : '否';
    states.push(`${key === 'italic' ? '斜体' : '粗体'}：${state}`);
  }
  return states.join('；') + (reasons.length ? `（${reasons.join('；')}）` : '');
}

function significantText(text, index, start = 0) {
  return text.replace(/[\s\-\u00ad\u2010\u2011\d]/g, (char, offset) => /\d/.test(char)
    && !(index?.formats?.[start + offset]?.name === 'a'
      && /\bhref\s*=\s*(["'])#Z?F\d+\1/i.test(index.formats[start + offset].definition.opening)) ? char : '');
}
function rangeAt(model, start, end) {
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
function textDiff(left, right, details = false, limit = Infinity) {
  if (left === right) return { distance: 0, parts: details ? (left ? [{ html: left, pdf: right, changed: false }] : []) : undefined };
  // A bounded match cannot span more extra characters than its edit limit.
  if (Number.isFinite(limit) && Math.abs(left.length - right.length) > limit && Math.abs(Array.from(left).length - Array.from(right).length) > limit)
    return { distance: limit + 1, parts: details ? [{ html: left, pdf: right, changed: true }] : undefined };
  // Bounded anchor checks and unavailable Monaco use the local engine directly.
  if (!computer || !details && Number.isFinite(limit)) return localTextDiff(left, right, details, limit);
  const fallback = details ? localTextDiff(left, right, true, 128) : null;
  if (fallback?.distance <= 128) return fallback;
  try {
    const result = computer.computeDiff(left.split("\n"), right.split("\n"), {
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
// A Levenshtein wavefront skips equal runs; traceback grows with edits, not file area.
function localTextDiff(left, right, details = false, limit = Infinity) {
  const originalA = [...left], originalB = [...right];
  const { start, oldEnd: endA, newEnd: endB } = changedRange(originalA, originalB);
  const a = originalA.slice(start, endA), b = originalB.slice(start, endB), n = a.length, m = b.length;
  const bound = Math.min(limit, details ? 128 : Infinity, Math.max(n, m));
  let previous = new Int32Array([0]), distance = 0;
  const waves = details ? [{ row: previous, trace: null }] : null;
  for (; distance < bound && previous[n - m + distance] !== n; ) {
    const score = ++distance, row = new Int32Array(2 * score + 1).fill(-1);
    const trace = details ? new Uint8Array(row.length) : null;
    for (let k = -score; k <= score; k++) {
      const at = k + score - 1;
      let x = -1, move = 0, candidate = previous[at];
      if (candidate >= 0 && candidate < n && candidate - k < m) x = candidate + 1;
      candidate = previous[at - 1];
      if (candidate >= 0 && candidate < n && candidate - k + 1 <= m && candidate + 1 > x) {
        x = candidate + 1;
        move = 1;
      }
      candidate = previous[at + 1];
      if (candidate >= 0 && candidate <= n && candidate - k - 1 < m && candidate > x) {
        x = candidate;
        move = 2;
      }
      if (x < 0) continue;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      row[k + score] = x;
      if (trace) trace[k + score] = move;
    }
    previous = row;
    if (details) waves.push({ row, trace });
  }
  if (previous[n - m + distance] !== n) return { distance: bound + 1, parts: details ? [{ html: left, pdf: right, changed: true }] : undefined };
  if (!details) return { distance };
  const reversed = [];
  let x = n, k = n - m;
  for (let score = distance; score > 0; score--) {
    const move = waves[score].trace[k + score], previousK = k + (move === 1 ? -1 : move === 2 ? 1 : 0);
    const previousX = waves[score - 1].row[previousK + score - 1], previousY = previousX - previousK;
    const fromX = previousX + (move !== 2), fromY = previousY + (move !== 1);
    if (x > fromX) reversed.push({ html: a.slice(fromX, x).join(''), pdf: b.slice(fromY, x - k).join(''), changed: false });
    reversed.push({ html: move === 2 ? '' : a[previousX], pdf: move === 1 ? '' : b[previousY], changed: true });
    x = previousX; k = previousK;
  }
  const parts = [];
  appendPart(parts, originalA.slice(0, start).join(''), originalB.slice(0, start).join(''), false);
  for (const part of reversed.reverse()) appendPart(parts, part.html, part.pdf, part.changed);
  appendPart(parts, originalA.slice(endA).join(''), originalB.slice(endB).join(''), false);
  return { distance, parts };
}
function changedRange(before, after) {
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return { start, oldEnd, newEnd };
}
function appendPart(parts, html, pdf, changed) {
  const last = parts.at(-1), previous = parts.at(-2);
  if (changed && !pdf && last?.changed === false && previous?.changed && !previous.pdf && /^[\p{L}\p{N}]+$/u.test(last.html) && html.endsWith(last.html)) previous.html += last.html + html.slice(0, -last.html.length);
  else if (last?.changed === changed) { last.html += html; last.pdf += pdf; }
  else if (html || pdf) parts.push({ html, pdf, changed });
}
function useMonaco(value) { computer = value; }
async function loadMonaco() {
  if (computer) return Promise.resolve(true);
  return monacoTask ||= import("/monaco/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js")
    .then(({ DefaultLinesDiffComputer }) => {
      computer = new DefaultLinesDiffComputer();
      return true;
    }).catch(() => false);
}
function normalized(raw, result = { text: "", starts: [], ends: [] }, base = 0) {
  let previous = result.text.at(-1) || "";
  const units = [], { starts, ends } = result;
  for (const match of raw.matchAll(/((?<=[\p{L}\p{N}])[-\u2010\u2011]\s*\n\s*(?=[\p{L}\p{N}]))|([a-zA-Z0-9]+)|(\s+)|(\.(?:\s*\.){2,})|[\s\S]/gu)) {
    const char = match[0], start = base + match.index, offset = start + char.length;
    if (match[1] || char === "\u00ad") continue;
    if (match[2]) {
      units.push(char.toLowerCase()); previous = char.at(-1);
      for (let i = 0; i < char.length; i++) { starts.push(start + i); ends.push(start + i + 1); }
      continue;
    }
    const value = match[3] ? ' ' : match[4] ? char.replace(/\s/g, '') : char >= '!' && char <= '~' ? char.toLowerCase() : char.normalize("NFKC").toLowerCase().replace(/ſ/g, "s").replace(/ß/g, "ss")
      .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/\s/g, " ");
    for (const unit of value) {
      if (unit === " " && previous === " ") { ends[ends.length - 1] = offset; continue; }
      units.push(unit); previous = unit;
      for (let i = 0; i < unit.length; i++) { starts.push(start); ends.push(offset); }
    }
  }
  result.text += units.join("");
  return result;
}
function approximateMatches(query, before, after, haystack) {
  const needle = normalized(query).text.trim();
  const size = [...needle].length, long = needle.length > 128;
  if (size && size < 3 || !size && (before.length < 4 || after.length < 4) || needle.length > 2048 || before.length + after.length < 8 || (long && (before.length < 12 || after.length < 12))) return [];
  const limit = !size ? 0 : long ? Math.min(32, Math.max(3, Math.floor(size * 0.05)))
    : Math.min(3, Math.max(1, Math.floor(size * 0.2)));
  const starts = new Set(), ends = new Set(), found = new Map(), text = haystack.text;
  for (const [context, left] of [[before, true], [after, false]]) {
    if (context.length < 4) continue;
    for (const size of [...new Set([Math.min(24, context.length), Math.min(12, context.length), ...(long ? [] : [4])])]) {
      const anchor = left ? context.slice(-size) : context.slice(0, size);
      let at = -1, anchored = false;
      while ((at = text.indexOf(anchor, at + 1)) !== -1) {
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
  for (const begin of starts) {
    const candidates = long ? ends : Array.from({ length: limit * 2 + 1 }, (_, i) => begin + needle.length - limit + i);
    for (const end of candidates) {
      if (Math.abs(end - begin - needle.length) > limit
        || begin < 0 || end > text.length || text[begin] === ' ' || text[end - 1] === ' ') continue;
      // Never cut a normalized glyph (e.g. a ligature or a surrogate pair).
      if ((begin && haystack.starts[begin] === haystack.starts[begin - 1]) || (end < text.length && haystack.starts[end] === haystack.starts[end - 1])) continue;
      const distance = textDiff(needle, text.slice(begin, end), false, limit).distance;
      if (size && !distance || distance > limit) continue;
      const start = haystack.starts[begin], stop = size ? haystack.ends[end - 1] : start;
      found.set(`${start}:${stop}`, { start, end: stop, approximate: true, distance });
    }
  }
  return [...found.values()];
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
  const definition = { name, opening: text, rawStart, openStart, openEnd: openStart + text.length,
    italic: italic && /^(normal|italic|oblique)\b/i.test(italic) ? !/^normal$/i.test(italic) : /^(i|em)$/.test(name) ? true : null,
    bold: bold && /^(normal|bold|[1-9]00)$/i.test(bold) ? /bold/i.test(bold) || Number(bold) >= 600 : /^(b|strong)$/.test(name) ? true : null };
  return definition;
}
// Text indexing, matching and confirmed HTML/PDF range alignment.
function extendPageRange(from, to, a, x, step, exact = false) {
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
  // Keep OCR errors and wrapped compounds inside the same confirmed word.
  let aa = a, xx = x;
  while (aa > 0 && aa < from.length && Math.abs(a - aa) < 32 && /^[\p{L}\p{N}\p{Pd}]{2}$/u.test(from.slice(aa - 1, aa + 1))) aa += step;
  while (xx > 0 && xx < to.length && Math.abs(x - xx) < 32 && /^[\p{L}\p{N}\p{Pd}]{2}$/u.test(to.slice(xx - 1, xx + 1))) xx += step;
  if ((a !== aa || x !== xx) && !/[\p{L}\p{N}\p{Pd}]/u.test(from[aa + offset] || '')
    && !/[\p{L}\p{N}\p{Pd}]/u.test(to[xx + offset] || '')
    && textDiff(from.slice(Math.min(a, aa), Math.max(a, aa)), to.slice(Math.min(x, xx), Math.max(x, xx)), false, 32).distance <= 32) { a = aa; x = xx; }
  return extendPageRange(from, to, a, x, step, true);
}
class PdfSourceIndex {
  connections = new WeakMap();
  pageScopes = new WeakMap();
  constructor(locator, values) {
    Object.assign(this, { locator }, values);
    this.normalized ||= normalized(this.raw);
  }
  connectionPairs(targets = [], prepared = false) {
    // Default marks keep their prepared diff while selections update the live mapping cache.
    return targets.filter(Boolean).flatMap(target => (prepared && this.pageScopes.get(target)?.connections || this.connections.get(target) || []).map(connection => [connection, target]))
      .sort(([, x], [, y]) => Number(!!x.pages) - Number(!!y.pages) || Number(!!y.layer) - Number(!!x.layer));
  }
  connectionDiff(target, connection) {
    if (!connection.editorDiff) {
      const html = this.raw.slice(connection.start, connection.end), pdf = target.raw.slice(connection.targetStart, connection.targetEnd);
      const diff = { distance: 0, parts: [] };
      let a = 0, b = 0, left = 0, right = 0;
      const compareTo = (endA = html.length, endB = pdf.length) => {
        if (endA < left || endB < right) return; // Expanded glyphs share raw positions; never consume them twice.
        const next = textDiff(html.slice(left, endA), pdf.slice(right, endB), true);
        diff.distance += next.distance;
        for (const part of next.parts) appendPart(diff.parts, part.html, part.pdf, part.changed);
        left = endA; right = endB;
      };
      // Keep normalized matches fixed: OCR spacing must not move deletions into a matching word.
      for (const span of connection.spans || []) {
        a += span.html.length; b += span.pdf.length;
        const trailing = span.html.length - span.html.trimEnd().length;
        if (!span.changed && trailing < span.html.length) {
          compareTo(connection.left?.starts[a - span.html.length], connection.right?.starts[b - span.pdf.length]);
          compareTo(connection.left?.ends[a - trailing - 1], connection.right?.ends[b - trailing - 1]);
        }
      }
      compareTo();
      connection.editorDiff = diff;
    }
    const diff = connection.editorDiff;
    diff.reliable ??= diff.distance <= 128 || !diff.parts.some(part => part.changed
      && Math.max(significantText(part.html).length, significantText(part.pdf).length) > 128);
    if (!diff.reliable) return null;
    let a = 0, b = 0;
    diff.ranges ||= diff.parts.map(part => [a, a += part.html.length, b, b += part.pdf.length, part]);
    return diff;
  }
  sourceRange(model, start, end) {
    return rangeAt(model, this.starts[start] ?? this.source.length,
      (end > start ? this.ends[end - 1] : this.starts[start]) ?? this.source.length);
  }
  missingRange(target, start, end, selectionStart = start, selectionEnd = end) {
    const ordered = (this.connections.get(target) || []).toSorted((a, b) => a.start - b.start);
    const before = ordered.findLast(c => c.end <= start), after = ordered.find(c => c.start >= end);
    if (!before && !after) return null;
    const a = before ? this.connectedRange(target, selectionStart, before.end)?.start ?? before.targetEnd : 0;
    const b = after ? this.connectedRange(target, after.start, selectionEnd)?.end ?? after.targetStart : target.raw.length;
    return b < a ? null : { start: a, end: target.raw.slice(a, b).trim() ? b : a, endBias: !!before };
  }
  reviewCandidates(targets = [], notice = null, connections = this.connectionPairs(targets, true), edits = true) {
    const items = [];
    const add = (start, parts, pdfRaw = '', pdfStart = 0, connection = null, missing = false) => {
      const projection = [];
      let left = start, right = pdfStart;
      for (const part of parts || []) {
        if (part.pdf.length) projection.push({ left, right, stop: right + part.pdf.length, part });
        left += part.html.length; right += part.pdf.length;
      }
      const project = (offset, endBias) => {
        const hit = projection[lowerBound(projection, offset, range => range.stop)];
        if (!hit) return left;
        if (!hit.part.changed) return hit.left + Math.max(0, offset - hit.right);
        if (offset <= hit.right) return hit.left;
        return endBias || offset === hit.stop ? hit.left + hit.part.html.length : hit.left;
      };
      for (const part of parts || []) {
        const from = start, end = start += part.html.length, at = pdfStart;
        pdfStart += part.pdf.length;
        if (part.changed && significantText(part.html, this, from) !== significantText(part.pdf)
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
          if (b < 0) b = this.raw.length;
          a = Math.max(0, a);
          b = Math.min(this.raw.length, b);
          const before = this.raw.slice(a, from), after = this.raw.slice(end, b);
          const preview = { html: this.raw.slice(a, b), pdf: before + part.pdf + after };
          this.locator.comparisonParts(preview, [{ html: before, pdf: before, changed: false }, part, { html: after, pdf: after, changed: false }]);
          items.splice(low, 0, {
            id: `${from}:${end}`, sourceStart: from, sourceEnd: end, preview, ...(missing ? { missing: true } : {}),
            comparison: { html: part.html, pdf: part.pdf }, options: [
              { id: 'pdf', label: '替换', edits: edits && !missing ? this.textEdits(from, end, part.pdf) : [] }
            ]
          });
        }
      }
    };
    for (const [connection, target] of connections)
      add(connection.start, this.connectionDiff(target, connection)?.parts, target.raw, connection.targetStart, connection);
    if (notice?.source && this.raw.slice(notice.source.start, notice.source.end) === notice.html)
      add(notice.source.start, this.locator.comparisonParts(notice));
    // Unmapped gaps in a recovered file are HTML additions with no reliable OCR counterpart.
    const target = (targets.length ? targets : connections.map(([, target]) => target)).find(target => target?.sourcePages?.length);
    if (target && (this.pageScopes.get(target)?.prepared || connections.some(([connection, index]) => index === target && connection.recovered))) {
      const ordered = connections.filter(([connection, index]) => (index === target || index.layer)
        && this.connectionDiff(index, connection)).map(([connection]) => connection).sort((a, b) => a.start - b.start);
      let start = this.raw.length - this.raw.trimStart().length;
      for (const range of [...ordered, { start: this.raw.trimEnd().length }]) {
        if (range.start > start) add(start, [{ html: this.raw.slice(start, range.start), pdf: '', changed: true }], '', 0, null, true);
        start = Math.max(start, range.end ?? range.start);
      }
    }
    return items;
  }

  fontRuns(start = 0, end = this.raw.length) {
    const runs = [];
    const parts = this.parts ? this.partsInRange(start, end)
      : this.pages?.filter(page => start < page.end && end > page.start).flatMap(page => page.parts) || [];
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
    const removed = tags.flatMap(tag => [
      { start: tag.openStart, end: tag.openEnd }, { start: tag.closeStart, end: tag.closeEnd }
    ]).filter(tag => tag.start >= a && tag.end <= b).sort((a, b) => b.start - a.start);
    const strip = (from, to) => {
      let text = this.source.slice(from, to);
      for (const tag of removed) if (tag.start >= from && tag.end <= to)
        text = text.slice(0, tag.start - from) + text.slice(tag.end - from);
      return text;
    };
    // Use source coordinates so whitespace entities also stay outside the tags.
    const leading = strip(a, this.starts[start]), trailing = strip(this.ends[end - 1], b);
    let text = strip(this.starts[start], this.ends[end - 1]);
    for (const key of keys) if (font[key]) {
      const name = key === 'italic' ? 'i' : 'b';
      text = `<${name}>${text}</${name}>`;
    }
    text = leading + text + trailing;
    // Keep the portions of enclosing wrappers outside the selected words.
    const left = tags.filter(tag => tag.openStart < a), right = tags.filter(tag => tag.closeEnd > b);
    const before = this.source.slice(0, a).match(/\s*$/u)[0];
    const after = this.source.slice(b).match(/^\s*/u)[0];
    if (left.length) { a -= before.length; text = left.slice().reverse().map(tag => tag.closing).join('') + before + text; }
    if (right.length) { b += after.length; text += after + right.map(tag => tag.opening).join(''); }
    return [{ start: a, end: b, expected: this.source.slice(a, b), text }];
  }
  // Reuse text alignment; changed spans require agreement on each PDF style.
  formatDifferences(connections, edits = true) {
    if (!this.formats) return [];
    const items = new Map();
    for (const [connection, target, diff] of connections) {
      const runs = this.formats ? target.fontRuns(connection.targetStart, connection.targetEnd) : [];
      let left = connection.start, right = connection.targetStart, run = 0;
      for (const part of (diff || this.connectionDiff(target, connection))?.parts || []) {
        while (run < runs.length && runs[run].end <= right) run++;
        let compared = [];
        if (part.changed && part.html.length) {
          // HTML-only text uses touching PDF runs on both sides of the boundary.
          for (let i = Math.max(0, run - 1); i < runs.length && runs[i].start <= right + part.pdf.length; i++) {
            const font = runs[i];
            if (part.pdf.length ? font.end > right && font.start < right + part.pdf.length
              : font.start <= right && font.end >= right) compared.push(font);
          }
          if (compared.length) {
            const font = { ...compared[0], start: right, end: right + part.pdf.length };
            for (const key of ['italic', 'bold'])
              if (!compared.every(value => value[key] === font[key])) font[key] = null;
            compared = [font];
          }
        } else if (!part.changed) {
          for (let i = run; i < runs.length && runs[i].start < right + part.pdf.length; i++) compared.push(runs[i]);
        }
        for (const font of compared) {
          if (typeof font.italic !== 'boolean' && typeof font.bold !== 'boolean') continue;
          const a = Math.max(right, font.start), b = Math.min(right + part.pdf.length, font.end);
          if (!part.changed && a >= b) continue;
          let start = part.changed ? left : left + a - right;
          const end = part.changed ? left + part.html.length : left + b - right;
          while (start < end) {
            const htmlFont = this.formats[start];
            let stop = start + 1;
            while (stop < end && this.formats[stop] === htmlFont) stop++;
            const differs = htmlFont && ['italic', 'bold'].some(key => typeof font[key] === 'boolean' && font[key] !== htmlFont[key]);
            if (differs) {
              const text = this.raw.slice(start, stop), a = start + (text.match(/^\s*/)?.[0].length || 0),
                b = stop - (text.match(/\s*$/)?.[0].length || 0), id = `font:${a}:${b}`;
              if (a < b && !items.has(id)) items.set(id, { sourceStart: a, sourceEnd: b, font, htmlFont,
                formats: [{ font, htmlFont }] });
            }
            start = stop;
          }
        }
        left += part.html.length;
        right += part.pdf.length;
      }
    }
    // Merge adjacent format changes, or bridge punctuation with the same mismatch.
    const merged = [];
    for (const item of [...items.values()].sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd)) {
      const previous = merged.at(-1), gap = previous && this.raw.slice(previous.sourceEnd, item.sourceStart);
      const joins = previous && item.sourceStart >= previous.sourceEnd && !/[\r\n]/.test(gap)
        && previous.htmlFont.tags === item.htmlFont.tags
        && ['italic', 'bold'].every(key => previous.font[key] === item.font[key] && previous.htmlFont[key] === item.htmlFont[key])
        && (!gap.trim() || !(/\s/u.test(gap) && /[\p{L}\p{N}]/u.test(gap)) && ['italic', 'bold'].some(key =>
          typeof previous.font[key] === 'boolean'
          && this.formats.slice(previous.sourceEnd, item.sourceStart).every((style, i) =>
            /\s/u.test(gap[i]) || (style && style[key] !== previous.font[key]))));
      if (!joins) { merged.push(item); continue; }
      previous.sourceEnd = item.sourceEnd;
      previous.formats.push(...item.formats);
    }
    return merged.map(item => ({ ...item, id: `font:${item.sourceStart}:${item.sourceEnd}`,
      text: this.raw.slice(item.sourceStart, item.sourceEnd),
      options: edits ? [{ id: 'format', edits: this.fontEdits(item.sourceStart, item.sourceEnd, item.font) }] : [] }));
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
  insertionSegment(start) {
    const at = this.starts[start] ?? this.ends[start - 1] ?? 0;
    return { start: at, end: at };
  }
  sourceDecorations(connections, model, fonts = true, text = true, targets = connections.map(([, target]) => target)) {
    const escape = text => JSON.stringify(text.trim() ? text : '').replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, '\\$&');
    const differences = (text ? this.reviewCandidates(targets, null, connections, false) : []).map(item => ({
      start: item.sourceStart, end: item.sourceEnd, text: true,
      insertions: item.sourceStart === item.sourceEnd ? [item.sourceStart] : [],
      messages: [item.missing ? 'PDF OCR 缺少相关文字。' : 'HTML: ' + escape(item.comparison.html) + '\n\nOCR: ' + escape(item.comparison.pdf)]
    }));
    for (const item of fonts ? this.formatDifferences(connections, false) : []) {
      const formats = item.formats || [item];
      differences.push({
        start: item.sourceStart, end: item.sourceEnd, font: true, insertions: [],
        messages: [`HTML ${fontSummary(formats.map(value => value.htmlFont))}\n\nPDF ${fontSummary(formats.map(value => value.font))}`]
      });
    }
    // Group visible ranges first so touching changes also join across HTML tags.
    differences.sort((a, b) => a.start - b.start || b.end - a.end);
    const decorations = [];
    for (let i = 0; i < differences.length; i++) {
      const item = differences[i];
      while (i + 1 < differences.length && differences[i + 1].start <= item.end) {
        const next = differences[++i];
        item.end = Math.max(item.end, next.end);
        item.text ||= next.text;
        item.font ||= next.font;
        item.messages.push(...next.messages);
        item.insertions.push(...next.insertions);
      }
      let description = 'PDF OCR text difference';
      if (item.text && item.font) description = 'PDF text and font difference';
      else if (item.font) description = 'PDF font difference';
      const options = {
        description, linesDecorationsClassName: 'mew-ocr-diff-line', stickiness: 1,
        inlineClassName: item.font ? 'mew-ocr-diff-text mew-font-diff-text' : 'mew-ocr-diff-text',
        hoverMessage: { value: [...new Set(item.messages)].join('\n\n'), isTrusted: false },
        linesDecorationsTooltip: [item.text && 'Text differs from PDF OCR', item.font && '粗体／斜体与 PDF 不一致'].filter(Boolean).join('；')
      };
      const segments = this.sourceSegments(item.start, item.end, Boolean(item.font) || !this.raw.slice(item.start, item.end).trim());
      if (!segments.length && item.text) item.insertions.push(item.start);
      for (const segment of segments) decorations.push({ ...segment, options });
      for (const start of new Set(item.insertions)) {
        const space = /[\p{L}\p{N}]/u.test(this.raw[start - 1] || '') ? undefined
          : [start, start - 1].find(at => /^[^\S\r\n]$/u.test(this.raw[at] || ''));
        const segment = space === undefined ? this.insertionSegment(start) : this.sourceSegments(space, space + 1, true)[0] || this.insertionSegment(start);
        decorations.push({ ...segment, options: segment.start !== segment.end ? options
          : { ...options, inlineClassName: undefined, showIfCollapsed: true,
            before: { content: '\u200b', inlineClassName: 'mew-ocr-diff-insert', inlineClassNameAffectsLetterSpacing: true } } });
      }
    }
    decorations.sort((a, b) => a.start - b.start || b.end - a.end);
    return decorations.map(({ start, end, options }) => ({ range: rangeAt(model, start, end), options }));
  }
  textEdits(start, end, replacement) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start
      || end > this.raw.length || typeof replacement !== 'string') throw new Error('无效的可见文字替换范围');
    const segments = this.sourceSegments(start, end, !this.raw.slice(start, end).trim());
    if (!segments.length) segments.push(this.insertionSegment(start));
    const text = replacement.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return segments.map((segment, i) => ({ ...segment, text: i ? '' : text,
      expected: this.source.slice(segment.start, segment.end) }));
  }
  rawRange(start, end, mapped = this) {
    return { start: lowerBound(mapped.ends, start + 1), end: lowerBound(mapped.starts, end) };
  }
  partsInRange(start, end) {
    const first = Math.min(this.parts.length - 1, lowerBound(this.parts, start + 1, part => part.end));
    return this.parts.slice(first, (start === end ? first : lowerBound(this.parts, end, part => part.end)) + 1);
  }
  sourcePageScope(page, connect = false) {
    const cached = this.pageScopes.get(page);
    if (cached && (!connect || cached.prepared)) return cached.scope;
    const from = page.normalized, to = this.normalized, text = from.text;
    let scope = connect && page.sourcePages?.length
      && this.rememberConnection(0, this.raw.length, page, { start: 0, end: page.raw.length }, { recover: true })
      ? { start: 0, end: this.raw.length } : this.locate({ text: page.raw, before: "", after: "" });
    if (scope && connect) this.rememberConnection(scope.start, scope.end, page, { start: 0, end: page.raw.length });
    for (const prepare of connect ? [true, false] : [false]) {
      if (scope) break;
      const size = Math.min(prepare ? 24 : 96, text.length), anchors = [];
      // Overlap prepared anchors so nearby OCR errors cannot hide a clean passage between samples.
      if (size >= 24) for (const at of new Set(prepare
        ? Array.from({ length: Math.ceil((text.length - size) / 8) + 1 }, (_, i) => Math.min(i * 8, text.length - size))
        : [0, .25, .5, .75, 1].map(ratio => Math.floor((text.length - size) * ratio)))) {
        const hits = this.matches([text.slice(at, at + size)], to, prepare && !this.locator.options.wholeWords);
        if (hits.length === 1) anchors.push({ at, start: lowerBound(to.starts, hits[0].start), end: lowerBound(to.starts, hits[0].end) });
      }
      if (anchors.length < 2) continue;
      if (prepare) {
        const confirmed = [];
        for (let i = 1; i < anchors.length; i++) {
          const a = anchors[i - 1], b = anchors[i];
          if (b.start <= a.start) continue;
          const left = from.text.slice(a.at, b.at + size), right = to.text.slice(a.start, b.end);
          const previous = confirmed.at(-1);
          const limit = Math.min(32, Math.max(12, Math.floor(left.length * .2)));
          if (left.length > 2048) continue;
          if (textDiff(left, right, false, limit).distance > limit) continue;
          // Use the connection budget on the union: overlapping samples must not count the same OCR errors twice.
          if (previous && previous.b >= a.at && previous.y >= a.start
            && textDiff(from.text.slice(previous.a, b.at + size), to.text.slice(previous.x, b.end), false, 128).distance <= 128) {
            previous.b = b.at + size;
            previous.y = b.end;
          } else confirmed.push({ a: a.at, b: b.at + size, x: a.start, y: b.end });
        }
        let previous = null;
        for (const range of confirmed) {
          let [a, x] = extendPageRange(from.text, to.text, range.a, range.x, -1);
          const aa = lowerBound(from.starts, page.raw.lastIndexOf('\n', from.starts[a] - 1) + 1);
          const xx = lowerBound(to.starts, this.raw.lastIndexOf('\n', to.starts[x] - 1) + 1);
          if (a > aa && x > xx && a - aa <= 32 && x - xx <= 32
            && /[\p{L}\p{N}]/u.test(to.text.slice(xx, x))
            && !/[\r\n]/.test(page.raw.slice(from.starts[a], from.ends[a]) + this.raw.slice(to.starts[x], to.ends[x]))) [a, x] = [aa, xx];
          const [b, y] = extendPageRange(from.text, to.text, range.b, range.y, 1);
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
      if (!anchors.every((anchor, i) => !i || anchor.start > anchors[i - 1].start)) continue;
      const first = anchors[0], last = anchors.at(-1);
      const start = Math.max(0, first.start - first.at - 32), end = Math.min(to.text.length, last.end + text.length - last.at - size + 32);
      // Context padding must stay within the PDF pages confirmed by the anchors.
      const firstPage = this.pages?.find(page => to.starts[first.start] >= page.start && to.starts[first.start] < page.end);
      const lastPage = this.pages?.find(page => to.starts[last.end - 1] >= page.start && to.starts[last.end - 1] <= page.end);
      scope = { start: Math.max(to.starts[start], firstPage?.start ?? 0), end: Math.min(to.ends[end - 1], lastPage?.end ?? this.raw.length) };
    }
    if (scope) scope.normalized = this.normalizedRange(scope.start, scope.end);
    this.pageScopes.set(page, { scope, prepared: connect, connections: connect ? this.connections.get(page) || [] : undefined });
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
  matches(queries, haystack = this.normalized, anchors = false) {
    const found = new Map(), word = char => !!char && /[\p{L}\p{N}_]/u.test(char);
    for (const query of queries) {
      const needle = anchors ? query : normalized(query).text.trim();
      if (!needle) continue;
      for (const at of this.matchPositions(needle, haystack, anchors)) {
        const end = at + needle.length;
        const before = [...haystack.text.slice(Math.max(0, at - 2), at)].pop(), after = [...haystack.text.slice(end, end + 2)][0];
        if (!this.locator.options.wholeWords || ((!word(needle[0]) || !word(before)) && (!word([...needle].pop()) || !word(after)))) {
          const start = haystack.starts[at], stop = haystack.ends[end - 1];
          found.set(`${start}:${stop}`, { start, end: stop });
          if (anchors && found.size > 1) return [...found.values()]; // Only unique anchors are useful.
        }
      }
    }
    return [...found.values()];
  }
  normalizedRange(start, end) {
    return start === 0 && end === this.raw.length ? this.normalized : normalized(this.raw.slice(start, end));
  }
  locate(entry, scope = null, fuzzyOnly = false) {
    const offset = scope?.start || 0, haystack = scope?.normalized || this.normalizedRange(offset, scope?.end ?? this.raw.length);
    const before = normalized(entry.before).text.trim(), after = normalized(entry.after).text.trim();
    const exact = fuzzyOnly ? [] : this.matches([entry.text], haystack);
    const hits = exact.length ? exact : approximateMatches(entry.text, before, after, haystack);
    if (!hits.length) return null;
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
    const required = Math.min(24, before.length + after.length);
    if (required && best.score < required) return exact.length ? this.locate(entry, scope, true) : null;
    return tied ? null : { ...best, start: best.start + offset, end: best.end + offset };
  }
  rememberConnection(start, end, target, hit, alignment) {
    if (start > end || hit.start > hit.end) return null;
    const cached = this.connections.get(target) || [];
    const existing = cached.find(item => item.start === start && item.end === end
      && item.targetStart === hit.start && item.targetEnd === hit.end);
    if (existing) return existing;
    const left = alignment?.left || this.normalizedRange(start, end),
      right = alignment?.right || target.normalizedRange(hit.start, hit.end);
    if (!left.text && !right.text) return null;
    const diff = alignment?.diff || textDiff(left.text, right.text, true);
    if (diff.distance > 128 && diff.parts.some(part => part.changed && Math.max(part.html.length, part.pdf.length) > 128)
      || alignment?.recover && diff.distance > 32 && !diff.parts.some(part => !part.changed && /[\p{L}\p{N}]{3}/u.test(part.html))) {
      if (!alignment?.recover) return null;
      // Recover word runs, keeping bounded OCR differences in the normal diff path.
      const words = text => text.match(/\S+\s*|\s+/gu) || [];
      const coarse = localTextDiff(words(left.text), words(right.text), true, 128), recovered = [];
      let a = 0, b = 0;
      for (const part of coarse.parts) {
        const x = a, y = b;
        a += part.html.length; b += part.pdf.length;
        if (!/[\p{L}\p{N}]/u.test(part.html) || part.changed && !textDiff(part.html, part.pdf, true).parts
          .some(span => !span.changed && /[\p{L}\p{N}]{3}/u.test(span.html))) continue;
        const connection = this.rememberConnection(start + left.starts[x], start + left.ends[a - 1], target,
          { start: hit.start + right.starts[y], end: hit.start + right.ends[b - 1] });
        if (connection) recovered.push(Object.assign(connection, { recovered: true }));
      }
      this.connections.set(target, [...recovered, ...cached]);
      return null;
    }
    const connection = { start, end, targetStart: hit.start, targetEnd: hit.end, left, right, distance: diff.distance, spans: diff.parts };
    this.connections.set(target, [connection, ...cached.filter(item => item.start !== start || item.end !== end)].slice(0, Math.max(16, this.raw.length)));
    return connection;
  }
  connectedRange(target, start, end, reverse = false, connection, marked = false) {
    if (start > end) return null;
    const begin = reverse ? 'targetStart' : 'start', stop = reverse ? 'targetEnd' : 'end';
    let connections = connection ? [connection] : this.connections.get(target) || [];
    connection ||= connections.find(item => start >= item[begin] && end <= item[stop]);
    // Add bounded gap diffs between confirmed neighbours in the same ordered traversal.
    if (!connection) connections = [...connections].sort((a, b) => a[begin] - b[begin]).flatMap((b, i, ordered) => {
      const a = ordered[i - 1];
      const gap = a && a[stop] < Math.min(end, b[begin]) && b[begin] > start
        && a.end <= b.start && a.targetEnd <= b.targetStart
        && Math.max(b.start - a.end, b.targetStart - a.targetEnd) <= 2048
        && this.rememberConnection(a.end, b.start, target, { start: a.targetEnd, end: b.targetStart });
      return gap ? [gap, b] : [b];
    });
    connection ||= connections.find(item => start >= item[begin] && end <= item[stop]);
    connections = connection ? [connection] : connections.filter(item => start < item[stop] && end > item[begin]);
    let first = Infinity, last = -1, covered = start;
    for (const item of connections) {
      const diff = this.connectionDiff(target, item);
      if (!diff) continue;
      if (item[begin] > covered) return null;
      covered = Math.max(covered, item[stop]);
      const a = start - item[begin], b = end - item[begin], offset = reverse ? item.start : item.targetStart;
      for (const [x, y, u, v, part] of diff.ranges) {
        const [left, right, targetLeft, targetRight] = reverse ? [u, v, x, y] : [x, y, u, v];
        if (a === b ? !part.changed || a < left || a > right || left !== right
          && !(marked && !part[reverse ? 'pdf' : 'html'].trim() && significantText(part[reverse ? 'html' : 'pdf']))
          : left === right && significantText(part[reverse ? 'html' : 'pdf'])
            ? left < a || left > b : right <= a || left >= b) continue;
        first = Math.min(first, offset + (part.changed ? targetLeft : targetLeft + Math.max(a, left) - left));
        last = Math.max(last, offset + (part.changed ? targetRight : targetLeft + Math.min(b, right) - left));
      }
    }
    if (covered < end || last < first || last === first && reverse) return null;
    const hit = { start: first, end: last, connection };
    return { ...hit, approximate: significantText((reverse ? target : this).raw.slice(start, end))
      !== significantText((reverse ? this : target).raw.slice(hit.start, hit.end)) };
  }
}
window.PdfSelectionDiff = {
  PdfSourceIndex, normalized, approximateMatches, lowerBound, htmlFontDefinition,
  textDiff, fontSummary,
  validateEdits, previewEdits, applyEdits, rangeAt, significantText, changedRange,
  get monacoAvailable() { return !!computer; },
  useMonaco, loadMonaco
};
