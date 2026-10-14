// PDF/source text indexing, location search and character alignment.
(() => {
  "use strict";
  let computer = null;
  window.PdfSelectionDiff = {
    localTextDiff, textDiff, sourceDecorations, createLocator,
    get monacoAvailable() { return !!computer; },
    monacoDiff: (left, right) => textDiff(left, right, true, Infinity, true),
    useMonaco(value) { computer = value; },
    async loadMonaco() {
      try {
        const { DefaultLinesDiffComputer } = await import("/monaco/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js");
        computer = new DefaultLinesDiffComputer();
        return true;
      } catch { return false; /* Standalone pages can use the local engine. */ }
    }
  };
  function textDiff(left, right, details = false, limit = Infinity, monacoOnly = false) {
    if (details && computer) {
      try {
        const result = computer.computeDiff(left.split("\n"), right.split("\n"), {
          ignoreTrimWhitespace: false, maxComputationTimeMs: 50,
          computeMoves: false, extendToSubwords: false
        });
        if (result.hitTimeout) throw new Error("Monaco diff timed out");
        const offsets = text => {
          const starts = [0];
          for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
          return (line, column) => starts[line - 1] + column - 1;
        };
        const offsetA = offsets(left), offsetB = offsets(right), parts = [];
        let a = 0, b = 0;
        const append = (html, pdf, changed) => {
          if (!html && !pdf) return;
          if (changed && monacoOnly) {
            // Monaco may extend a character change to word boundaries.
            let prefix = 0, suffix = 0;
            while (prefix < Math.min(html.length, pdf.length) && html[prefix] === pdf[prefix]) prefix++;
            if (prefix && /[\uD800-\uDBFF]/.test(html[prefix - 1])) prefix--;
            while (suffix < Math.min(html.length, pdf.length) - prefix && html.at(-suffix - 1) === pdf.at(-suffix - 1)) suffix++;
            if (suffix && /[\uDC00-\uDFFF]/.test(html[html.length - suffix])) suffix--;
            if (prefix || suffix) {
              append(html.slice(0, prefix), pdf.slice(0, prefix), false);
              append(html.slice(prefix, html.length - suffix), pdf.slice(prefix, pdf.length - suffix), true);
              append(html.slice(html.length - suffix), pdf.slice(pdf.length - suffix), false);
              return;
            }
          }
          if (!changed && html !== pdf) throw new Error("Incomplete Monaco ranges");
          const last = parts.at(-1);
          if (last?.changed === changed) { last.html += html; last.pdf += pdf; }
          else parts.push({ html, pdf, changed });
        };
        for (const change of result.changes) {
          if (!change.innerChanges?.length) throw new Error("Missing Monaco character ranges");
          for (const { originalRange: x, modifiedRange: y } of change.innerChanges) {
            const startA = offsetA(x.startLineNumber, x.startColumn), endA = offsetA(x.endLineNumber, x.endColumn);
            const startB = offsetB(y.startLineNumber, y.startColumn), endB = offsetB(y.endLineNumber, y.endColumn);
            if (![startA, endA, startB, endB].every(Number.isInteger) || startA < a || startB < b
              || endA < startA || endB < startB || endA > left.length || endB > right.length) throw new Error("Invalid Monaco ranges");
            append(left.slice(a, startA), right.slice(b, startB), false);
            append(left.slice(startA, endA), right.slice(startB, endB), true);
            a = endA; b = endB;
          }
        }
        append(left.slice(a), right.slice(b), false);
        if (monacoOnly) return { parts };
        // OCR acceptance uses bounded edit distance; Monaco determines character positions.
        const { distance } = localTextDiff(left, right, false, Math.min(limit, 128));
        if (distance > Math.min(limit, 128)) return localTextDiff(left, right, details, limit);
        return { distance, parts };
      } catch { /* Failed or incomplete mappings use local traceback. */ }
    }
    return monacoOnly ? null : localTextDiff(left, right, details, limit);
  }
  function sourceDecorations(index, connections, model) {
    if (!computer) return [];
    const decorations = [], seen = new Set();
    for (const [connection, target] of connections) {
      const diff = connection.editorDiff ||= textDiff(index.raw.slice(connection.start, connection.end),
        target.raw.slice(connection.targetStart, connection.targetEnd), true, Infinity, true);
      if (!diff) continue;
      let cursor = connection.start;
      for (const part of diff.parts) {
        const end = cursor + part.html.length;
        if (part.changed && part.html.replace(/[\s\-\u00ad\u2010\u2011]/g, '') !== part.pdf.replace(/[\s\-\u00ad\u2010\u2011]/g, '')) {
          const escape = text => JSON.stringify(text).replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, '\\$&');
          const hoverMessage = { value: 'HTML: ' + escape(part.html) + '\n\nOCR: ' + escape(part.pdf), isTrusted: false };
          // Split around markup, retaining complete encoded entities and UTF-16 offsets.
          let at = cursor;
          do {
            const start = index.starts[at] ?? index.ends[at - 1] ?? 0;
            let stop = start;
            if (at < end) {
              stop = index.ends[at++];
              while (at < end && index.starts[at] <= stop) stop = index.ends[at++];
            }
            if (index.source?.slice(start, stop).startsWith('<')) continue;
            const key = `${start}:${stop}`;
            if (!seen.has(key)) {
              seen.add(key);
              const a = model.getPositionAt(start), b = model.getPositionAt(stop);
              decorations.push({ range: { startLineNumber: a.lineNumber, startColumn: a.column,
                endLineNumber: b.lineNumber, endColumn: b.column }, options: {
                description: 'PDF OCR text difference', linesDecorationsClassName: 'mew-ocr-diff-line',
                inlineClassName: part.html.length ? 'mew-ocr-diff-text' : undefined,
                beforeContentClassName: part.html.length ? undefined : 'mew-ocr-diff-insert',
                hoverMessage, linesDecorationsTooltip: 'Text differs from PDF OCR', stickiness: 1
              } });
            }
          } while (at < end);
        }
        cursor = end;
      }
    }
    return decorations;
  }
  // Each reader owns its source/document caches; the host supplies current PDF/layer state.
  function createLocator(options = {}, environment = {}) {
    const documents = new WeakMap(), sourceIndexes = new WeakMap();
    const document = environment.document || window.document;
    return { sourceIndex, editorSourceIndex, sourcePageScope, normalized, matches, locate,
      normalizedRange, approximateMatches, lowerBound, rememberConnection, patchedWords,
      connectedRange, indexDocument, getDocumentIndex, findLocations, prepareSource, locateSource, locateLayer };
    // Decode source text without losing offsets into Monaco's original HTML.
    function sourceIndex(source) {
      const template = document.createElement("template"), starts = [], ends = [];
      let raw = "", ignored = "";
      const tokens = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);|[^<&]+|[<&]/gi;
      for (const token of source.matchAll(tokens)) {
        const text = token[0], tag = /^<(\/?)\s*([a-z][\w:-]*)/i.exec(text);
        if (ignored) { if (tag?.[1] && tag[2].toLowerCase() === ignored) ignored = ""; continue; }
        let value = text, encoded = false;
        if (tag) {
          const name = tag[2].toLowerCase();
          if (!tag[1] && /^(head|script|style)$/.test(name)) ignored = name;
          value = (tag[1] && /^(p|div|li|h[1-6])$/.test(name)) || name === "br" ? "\n" : "";
          encoded = true;
        } else if (text.startsWith("<!")) value = "";
        else if (text.startsWith("&") && text.endsWith(";")) {
          template.innerHTML = text; value = template.content.textContent; encoded = value !== text;
        }
        raw += value;
        for (let i = 0; i < value.length; i++) {
          starts.push(token.index + (encoded ? 0 : i));
          ends.push(token.index + (encoded ? text.length : i + 1));
        }
      }
      return { raw, starts, ends, normalized: normalized(raw), pageScopes: new WeakMap(), connections: new WeakMap() };
    }
    function editorSourceIndex(model) {
      const version = model.getVersionId?.(), previous = sourceIndexes.get(model);
      if (version !== undefined && previous?.version === version) return previous;
      const source = model.getValue(); if (previous?.source === source && previous.version === version) return previous;
      const index = { source, version, ...sourceIndex(source) };
      if (previous) {
        let start = 0, oldEnd = previous.raw.length, newEnd = index.raw.length;
        while (start < oldEnd && start < newEnd && previous.raw[start] === index.raw[start]) start++;
        while (oldEnd > start && newEnd > start && previous.raw[oldEnd - 1] === index.raw[newEnd - 1]) { oldEnd--; newEnd--; }
        // Carry only unchanged passages; offsets within each diff remain relative to its passage.
        const shift = range => range && (range.end <= start ? 0 : range.start >= oldEnd ? newEnd - oldEnd : null);
        const targets = environment.getTargets?.() || [];
        const full = getDocumentIndex(environment.getPdf?.());
        if (full) targets.push(full);
        for (const target of targets.filter(Boolean)) {
          const retained = (previous.connections.get(target) || []).flatMap(item => {
            const delta = shift(item); return delta === null ? [] : [{ ...item, start: item.start + delta, end: item.end + delta }];
          });
          if (retained.length) index.connections.set(target, retained);
          const cached = previous.pageScopes.get(target), delta = shift(cached?.scope);
          if (cached?.scope && delta !== null) index.pageScopes.set(target, { ...cached, scope: { ...cached.scope, start: cached.scope.start + delta, end: cached.scope.end + delta } });
        }
      }
      sourceIndexes.set(model, index);
      return index;
    }
    function sourcePageScope(index, page, connect = false) {
      const cached = index.pageScopes.get(page);
      if (cached && (!connect || cached.prepared)) return cached.scope;
      let scope = locate(index.raw, { text: page.raw, before: "", after: "" }, index.normalized);
      if (!scope) {
        const text = page.normalized.text, size = Math.min(connect ? 32 : 96, text.length), anchors = [];
        // Overlap prepared anchors so nearby OCR errors cannot hide a clean passage between samples.
        const positions = connect ? Array.from({ length: Math.ceil((text.length - size) / 16) + 1 }, (_, i) => Math.min(i * 16, text.length - size))
          : [0, .25, .5, .75, 1].map(ratio => Math.floor((text.length - size) * ratio));
        if (size >= 24) for (const at of new Set(positions)) {
          const hits = connect && size >= 31 && !options.wholeWords ? anchorMatches(index, text.slice(at, at + size))
            : matches(index.raw, [text.slice(at, at + size)], index.normalized);
          if (hits.length === 1) anchors.push({ at, start: lowerBound(index.normalized.starts, hits[0].start), end: lowerBound(index.normalized.starts, hits[0].end) });
        }
        if (anchors.length >= 2) {
          if (connect) {
            const confirmed = [], from = page.normalized, to = index.normalized;
            for (let i = 1; i < anchors.length; i++) {
              const a = anchors[i - 1], b = anchors[i];
              if (b.start <= a.start) continue;
              const left = from.text.slice(a.at, b.at + size), right = to.text.slice(a.start, b.end);
              const range = { start: from.starts[a.at], end: from.ends[b.at + size - 1], hit: { start: to.starts[a.start], end: to.ends[b.end - 1] } };
              const reused = connectedRange(index, page, range.hit.start, range.hit.end), previous = confirmed.at(-1);
              const limit = Math.min(32, Math.max(12, Math.floor(left.length * .08)));
              if (left.length > 2048) continue;
              const distance = reused?.start === range.start && reused.end === range.end ? 0 : textDiff(left, right, false, limit).distance;
              if (distance <= limit) {
                if (previous && previous.end >= range.start && previous.hit.end >= range.hit.start && previous.distance + distance <= 96) {
                  previous.end = range.end; previous.hit.end = range.hit.end; previous.distance += distance;
                } else confirmed.push({ ...range, distance });
              }
            }
            // Join validated neighbouring passages before selection, including full-file ranges.
            for (const range of confirmed) rememberConnection(index, range.hit.start, range.hit.end, page, range);
          }
          if (anchors.every((anchor, i) => !i || anchor.start > anchors[i - 1].start)) {
            const first = anchors[0], last = anchors.at(-1), mapped = index.normalized;
            const start = Math.max(0, first.start - first.at - 32), end = Math.min(mapped.text.length, last.end + text.length - last.at - size + 32);
            scope = { start: mapped.starts[start], end: mapped.ends[end - 1] };
          }
        }
      }
      if (scope) {
        scope.normalized = normalizedRange(index, scope.start, scope.end);
        if (connect && (scope.approximate || scope.normalized.text === page.normalized.text.trim()))
          rememberConnection(index, scope.start, scope.end, page, { start: 0, end: page.raw.length });
      }
      if (!scope && connect) scope = sourcePageScope(index, page);
      index.pageScopes.set(page, { scope, prepared: connect });
      return scope;
    }
    function anchorMatches(index, needle) {
      // Every 32-character anchor contains a complete aligned 16-character block.
      // Build once, then verify candidates instead of rescanning a whole volume per anchor.
      const mapped = index.normalized, text = mapped.text, found = new Map();
      if (!index.anchorBlocks) {
        const blocks = index.anchorBlocks = new Map();
        for (let at = 0; at + 16 <= text.length; at += 16) {
          const key = text.slice(at, at + 16), positions = blocks.get(key);
          if (positions) positions.push(at); else blocks.set(key, [at]);
        }
      }
      for (let offset = 0; offset < 16 && offset + 16 <= needle.length; offset++) {
        for (const position of index.anchorBlocks.get(needle.slice(offset, offset + 16)) || []) {
          const at = position - offset;
          if (at >= 0 && text.startsWith(needle, at)) {
            const start = mapped.starts[at], end = mapped.ends[at + needle.length - 1];
            found.set(`${start}:${end}`, { start, end });
            if (found.size > 1) return [...found.values()]; // Only unique anchors are useful.
          }
        }
      }
      return [...found.values()];
    }
    // Normalize search text while keeping UTF-16 source offsets for DOM Ranges.
    function normalized(raw, result = { text: "", starts: [], ends: [] }, base = 0) {
      let previous = result.text.at(-1) || "";
      const units = [], { starts, ends } = result;
      for (const match of raw.matchAll(/((?<=[\p{L}\p{N}])[-\u2010\u2011]\s*\n\s*(?=[\p{L}\p{N}]))|[\s\S]/gu)) {
        const char = match[0], start = base + match.index, offset = start + char.length;
        if (match[1] || char === "\u00ad") continue;
        const value = char.normalize("NFKC").toLowerCase().replace(/ſ/g, "s").replace(/ß/g, "ss")
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
    function matches(raw, queries, haystack = normalized(raw)) {
      const found = [], seen = new Set(), word = char => !!char && /[\p{L}\p{N}_]/u.test(char);
      for (const query of queries) {
        const needle = normalized(query).text.trim();
        if (!needle) continue;
        let at = 0;
        while ((at = haystack.text.indexOf(needle, at)) !== -1) {
          const end = at + needle.length;
          const before = [...haystack.text.slice(Math.max(0, at - 2), at)].pop(), after = [...haystack.text.slice(end, end + 2)][0];
          if (!options.wholeWords || ((!word(needle[0]) || !word(before)) && (!word([...needle].pop()) || !word(after)))) {
            const start = haystack.starts[at], stop = haystack.ends[end - 1], key = `${start}:${stop}`;
            if (!seen.has(key)) { found.push({ start, end: stop }); seen.add(key); }
          }
          at++;
        }
      }
      return found;
    }
    function normalizedRange(index, start, end) {
      // Whole-index maps are reusable; partial ranges need their own boundary handling.
      return start === 0 && end === index.raw.length && index.normalized
        ? index.normalized : normalized(index.raw.slice(start, end));
    }
    function locate(raw, entry, haystack = normalized(raw), fuzzyOnly = false) {
      const before = normalized(entry.before).text.trim(), after = normalized(entry.after).text.trim();
      const exact = fuzzyOnly ? [] : matches(raw, [entry.text], haystack);
      const hits = exact.length ? exact : approximateMatches(entry.text, before, after, haystack);
      if (!hits.length) return null;
      const scored = hits.map(hit => {
        const begin = lowerBound(haystack.starts, hit.start), end = lowerBound(haystack.starts, hit.end);
        const left = haystack.text.slice(Math.max(0, begin - 400), begin).trim();
        const right = haystack.text.slice(end, end + 400).trim();
        let a = 0, b = 0;
        while (a < before.length && a < left.length && before.at(-a - 1) === left.at(-a - 1)) a++;
        while (b < after.length && b < right.length && after[b] === right[b]) b++;
        return { ...hit, score: a + b };
      }).sort((a, b) => b.score - a.score);
      const required = Math.min(24, before.length + after.length);
      if (required && scored[0].score < required) return exact.length ? locate(raw, entry, haystack, true) : null;
      return scored.length === 1 || scored[0].score > scored[1].score ? scored[0] : null;
    }
    function approximateMatches(query, before, after, haystack) {
      const needle = normalized(query).text.trim();
      const size = [...needle].length, long = needle.length > 128;
      if (size < 3 || needle.length > 2048 || before.length + after.length < 8 || (long && (before.length < 12 || after.length < 12))) return [];
      const limit = long ? Math.min(32, Math.max(3, Math.floor(size * 0.05)))
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
            if (left) while (text[boundary] === ' ') boundary++;
            else while (boundary && text[boundary - 1] === ' ') boundary--;
            if (left) starts.add(boundary);
            else if (long) ends.add(boundary);
            else for (let delta = -limit; delta <= limit; delta++) starts.add(boundary - needle.length + delta);
            if (starts.size > 200 || ends.size > 200) return [];
          }
          if (anchored) break;
        }
      }
      for (const begin of starts) {
        const candidates = long ? ends : Array.from({ length: limit * 2 + 1 }, (_, i) => begin + needle.length - limit + i);
        for (const end of candidates) {
          if (Math.abs(end - begin - needle.length) > limit) continue;
          if (begin < 0 || end > text.length || text[begin] === ' ' || text[end - 1] === ' ') continue;
          // Never cut a normalized glyph (e.g. a ligature or a surrogate pair).
          if ((begin && haystack.starts[begin] === haystack.starts[begin - 1]) || (end < text.length && haystack.starts[end] === haystack.starts[end - 1])) continue;
          const distance = textDiff(needle, text.slice(begin, end), false, limit).distance;
          if (!distance || distance > limit) continue;
          const start = haystack.starts[begin], stop = haystack.ends[end - 1];
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
    function rememberConnection(source, start, end, target, hit, alignment) {
      const cached = source.connections.get(target) || [];
      const existing = cached.find(item => item.start === start && item.end === end
        && item.targetStart === hit.start && item.targetEnd === hit.end);
      if (existing) return existing;
      const left = alignment?.left || normalizedRange(source, start, end), right = alignment?.right || normalizedRange(target, hit.start, hit.end);
      if (!left.text || !right.text) return null;
      const diff = alignment?.diff || textDiff(left.text, right.text, true);
      if (diff.distance > 128) return null;
      const connection = { start, end, targetStart: hit.start, targetEnd: hit.end, left, right, distance: diff.distance, spans: diff.parts, patches: [] };
      let a = 0;
      for (const span of connection.spans) {
        if (span.changed) {
          let begin = a, stop = a + span.html.length;
          while (begin && /[\p{L}\p{N}]/u.test(left.text[begin - 1])) begin--;
          while (stop < left.text.length && /[\p{L}\p{N}]/u.test(left.text[stop])) stop++;
          const from = left.text.slice(begin, stop);
          const mapped = from && connectedRange(source, target, start + left.starts[begin], start + left.ends[stop - 1], false, connection);
          const to = mapped && normalized(target.raw.slice(mapped.start, mapped.end)).text;
          if (to && !/\s/.test(from + to)) connection.patches.push([from, to]);
        }
        a += span.html.length;
      }
      source.connections.set(target, [connection, ...cached.filter(item => item.start !== start || item.end !== end)].slice(0, Math.max(16, Math.ceil(source.raw.length / 64))));
      return connection;
    }
    function patchedWords(entry, target) {
      const patches = new Map();
      for (const [from, to] of (entry.index?.connections.get(target) || []).flatMap(connection => connection.patches))
        patches.set(from, patches.has(from) && patches.get(from) !== to ? null : to);
      const text = normalized(entry.text).text.replace(/[\p{L}\p{N}]+/gu, word => patches.get(word) || word);
      return [...new Set(text.match(/[\p{L}\p{N}]+(?:[-/'\\][\p{L}\p{N}]+)*/gu) || [])];
    }
    function connectedRange(source, target, start, end, reverse = false, connection, marked = false) {
      connection ||= (source.connections.get(target) || []).find(item => start >= (reverse ? item.targetStart : item.start)
        && end <= (reverse ? item.targetEnd : item.end));
      if (!connection || start > end) return null;
      const raw = (marked || start === end) && !reverse && (connection.editorDiff ||= textDiff(source.raw.slice(connection.start, connection.end),
        target.raw.slice(connection.targetStart, connection.targetEnd), true, Infinity, true));
      if ((marked || start === end) && !reverse && !raw) return null;
      const from = raw ? { text: source.raw.slice(connection.start, connection.end) } : reverse ? connection.right : connection.left,
        to = raw ? { text: target.raw.slice(connection.targetStart, connection.targetEnd) } : reverse ? connection.left : connection.right;
      const offset = reverse ? connection.targetStart : connection.start, targetOffset = reverse ? connection.start : connection.targetStart;
      const a = raw ? start - offset : lowerBound(from.ends, start - offset + 1),
        b = raw ? end - offset : lowerBound(from.starts, end - offset);
      let first = Infinity, last = -1, cursorA = 0, cursorB = 0;
      for (const span of raw ? raw.parts : connection.spans) {
        const left = cursorA, right = cursorA += span[reverse ? 'pdf' : 'html'].length,
          targetLeft = cursorB, targetRight = cursorB += span[reverse ? 'html' : 'pdf'].length;
        if (raw && a === b ? !span.changed || left !== a || right !== a : right <= a || left >= b) continue;
        // A changed run has no reliable per-character correspondence; include its whole counterpart.
        first = Math.min(first, span.changed ? targetLeft : targetLeft + Math.max(a, left) - left);
        last = Math.max(last, span.changed ? targetRight : targetLeft + Math.min(b, right) - left);
      }
      if (last === first && !reverse) {
        const anchor = targetOffset + (raw ? first : to.starts[first] ?? to.ends[first - 1] ?? 0);
        return { start: anchor, end: anchor, connection, approximate: true };
      }
      if (last <= first) return null;
      const hit = { start: targetOffset + (raw ? first : to.starts[first]), end: targetOffset + (raw ? last : to.ends[last - 1]), connection };
      hit.approximate = from.text.slice(a, b) !== to.text.slice(first, last);
      return hit;
    }
    async function indexDocument(pdf) {
      if (documents.has(pdf)) return documents.get(pdf).task;
      const cached = {};
      documents.set(pdf, cached);
      cached.task = (async () => {
        let raw = "", mappedStart = 0;
        const pages = [], mapped = { text: "", starts: [], ends: [] };
        for (let number = 1; number <= pdf.numPages; number++) {
          if (!environment.isCurrent(pdf)) return null;
          await environment.waitForIdle(pdf);
          if (!environment.isCurrent(pdf)) return null;
          const page = await pdf.getPage(number), content = await page.getTextContent();
          const start = raw.length, parts = [];
          let previous = null, pageRaw = "";
          for (const item of content.items) {
            if (typeof item.str !== "string") continue;
            if (previous && !pageRaw.endsWith("\n")) {
              const lineBreak = Math.abs(item.transform[5] - previous.transform[5]) > Math.max(item.height, previous.height) * 0.5;
              if (lineBreak) pageRaw += "\n";
              else if (item.transform[4] - previous.transform[4] - previous.width > Math.max(item.height, previous.height) * 0.08) pageRaw += " ";
            }
            parts.push({ start: start + pageRaw.length, end: start + pageRaw.length + item.str.length, item });
            pageRaw += item.str;
            if (item.hasEOL) pageRaw += "\n";
            previous = item;
          }
          pages.push({ number, start, end: start + pageRaw.length, parts });
          raw += pageRaw + "\n";
          if (!/[-\u2010\u2011]\s*$/.test(raw.slice(mappedStart))) {
            normalized(raw.slice(mappedStart), mapped, mappedStart); mappedStart = raw.length;
          }
        }
        normalized(raw.slice(mappedStart), mapped, mappedStart);
        cached.index = { raw, pages, normalized: mapped, connections: new WeakMap(), pageScopes: new WeakMap() };
        if (environment.isCurrent(pdf)) environment.onIndexed?.();
        return cached.index;
      })().catch(error => { documents.delete(pdf); throw error; });
      const index = await cached.task;
      if (!index) documents.delete(pdf);
      return index;
    }
    function findLocations(pdf, entries) {
      const documentIndex = documents.get(pdf)?.index;
      const visible = environment.getVisiblePages?.() || [];
      const locations = entries.map(entry => {
        let index = documentIndex, hit = null, number;
        for (const page of visible) {
          if (page.index && entry.index) sourcePageScope(entry.index, page.index, true);
          hit = page.index && entry.index && connectedRange(entry.index, page.index, entry.start, entry.end, false, undefined, entry.marked);
          if (hit) { index = page.index; number = page.number; break; }
        }
        if (!hit && index) hit = (entry.index && connectedRange(entry.index, index, entry.start, entry.end, false, undefined, entry.marked)) || locate(index.raw, entry, index.normalized);
        if (!hit) return { entry, targets: [], queries: index ? patchedWords(entry, index) : [entry.text] };
        const connection = hit.connection || (entry.index && rememberConnection(entry.index, entry.start, entry.end, index, hit));
        const pages = index.pages || [{ number, start: 0, end: index.raw.length, parts: index.parts }];
        const targets = pages.filter(page => hit.start === hit.end ? hit.start >= page.start && hit.start <= page.end
          : hit.start < page.end && hit.end > page.start).map(page => {
          const start = Math.max(hit.start, page.start), end = Math.min(hit.end, page.end);
          const target = { pageNumber: page.number, item: page.parts.find(part => part.end > start)?.item,
            difference: hit.approximate || entry.marked && entry.text !== index.raw.slice(hit.start, hit.end)
              ? { html: entry.text, pdf: index.raw.slice(hit.start, hit.end) } : null,
            marked: entry.marked, text: index.raw.slice(start, end), before: index.raw.slice(Math.max(page.start, start - 160), start),
            after: index.raw.slice(end, Math.min(page.end, end + 160)) };
          const sourceRange = entry.marked || entry.start === entry.end ? entry : connection && connectedRange(entry.index, index, start, end, true, connection);
          if (sourceRange || hit.start === hit.end) Object.assign(target, { index: entry.index,
            start: sourceRange?.start ?? entry.start, end: sourceRange?.end ?? entry.end });
          return target;
        });
        return { entry, targets };
      });
      if (documentIndex || locations.every(location => location.targets.length)) return locations;
      return indexDocument(pdf).then(index => index ? findLocations(pdf, entries) : locations);
    }
    function getDocumentIndex(pdf) { return documents.get(pdf)?.index; }
    function prepareSource(source, pages, pdf) {
      if (!source) return;
      const full = getDocumentIndex(pdf);
      if (computer && full && source.preparedDocument !== full) {
        sourcePageScope(full, source, true);
        for (const item of full.connections.get(source) || [])
          rememberConnection(source, item.targetStart, item.targetEnd, full, { start: item.start, end: item.end }, {
            left: item.right, right: item.left, diff: { distance: item.distance,
              parts: item.spans.map(span => ({ html: span.pdf, pdf: span.html, changed: span.changed })) }
          });
        source.preparedDocument = full;
      }
      for (const page of pages) if (page) sourcePageScope(source, page, true);
      source.preparedPdf = pdf;
    }
    function locateSource(index, chunks) {
      const first = chunks[0], last = chunks.at(-1);
      const entry = {
        text: chunks.map(({ index, start, end }) => index.raw.slice(start, end)).join("\n"),
        before: first.index.raw.slice(Math.max(0, first.start - 160), first.start),
        after: last.index.raw.slice(last.end, last.end + 160)
      };
      const left = sourcePageScope(index, first.index, true), right = sourcePageScope(index, last.index, true);
      let hit = chunks.length === 1 && connectedRange(index, first.index, first.start, first.end, true);
      if (!hit) {
        const scope = left && right && left.start <= right.start ? { start: left.start, end: right.end } : null;
        const local = scope && locate(index.raw.slice(scope.start, scope.end), entry, left === right ? left.normalized : undefined);
        hit = local ? { ...local, start: local.start + scope.start, end: local.end + scope.start }
          : scope ? null : locate(index.raw, entry, index.normalized);
      }
      const html = hit && index.raw.slice(hit.start, hit.end);
      const differs = hit && (hit.connection ? hit.approximate : normalized(html).text !== normalized(entry.text).text);
      const difference = !hit ? { message: "No reliable HTML match" } : differs ? { html, pdf: entry.text } : null;
      if (chunks.length === 1 && hit?.approximate && !hit.connection)
        rememberConnection(index, hit.start, hit.end, first.index, { start: first.start, end: first.end });
      return { hit, difference };
    }
    function locateLayer(index, queries, targets = []) {
      const { raw } = index;
      const hits = [];
      let focusHit = null;
      for (const target of targets) {
        const connection = target.index && connectedRange(target.index, index, target.start, target.end, false, undefined, target.marked);
        const hit = target.range || connection || locate(raw, target, index.normalized);
        if (hit && target.index && !connection) rememberConnection(target.index, target.start, target.end, index, hit);
        if (hit) {
          hit.difference = target.difference || (hit.approximate ? { html: target.text, pdf: raw.slice(hit.start, hit.end) } : null);
          hit.source = target.index && { index: target.index, start: target.start, end: target.end };
        }
        if (hit && !focusHit) focusHit = hit;
        // Retain exact fallback highlights when rendered spacing prevents confirmation.
        for (const match of hit ? [hit] : matches(raw, target.index ? patchedWords(target, index) : [target.text], index.normalized))
          if (!hits.some(other => other.start === match.start && other.end === match.end)) hits.push(match);
      }
      for (const match of matches(raw, queries, index.normalized))
        if (!hits.some(hit => hit.start === match.start && hit.end === match.end)) hits.push(match);
      return { hits, focusHit };
    }
  }
  // A Levenshtein wavefront skips equal runs; traceback grows with edits, not file area.
  function localTextDiff(left, right, details = false, limit = Infinity) {
    const originalA = [...left], originalB = [...right];
    let start = 0, endA = originalA.length, endB = originalB.length;
    while (start < endA && start < endB && originalA[start] === originalB[start]) start++;
    while (endA > start && endB > start && originalA[endA - 1] === originalB[endB - 1]) { endA--; endB--; }
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
        if (candidate >= 0 && candidate < n && candidate - k + 1 <= m && candidate + 1 > x) { x = candidate + 1; move = 1; }
        candidate = previous[at + 1];
        if (candidate >= 0 && candidate <= n && candidate - k - 1 < m && candidate > x) { x = candidate; move = 2; }
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
    const parts = [], append = (html, pdf, changed) => {
      if (!html && !pdf) return;
      const last = parts.at(-1);
      if (last?.changed === changed) { last.html += html; last.pdf += pdf; }
      else parts.push({ html, pdf, changed });
    };
    append(originalA.slice(0, start).join(''), originalB.slice(0, start).join(''), false);
    for (const part of reversed.reverse()) append(part.html, part.pdf, part.changed);
    append(originalA.slice(endA).join(''), originalB.slice(endB).join(''), false);
    return { distance, parts };
  }
})();
