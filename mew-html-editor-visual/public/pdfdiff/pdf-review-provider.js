// PDF mapping, review candidates, provider actions and highlights.
window.PdfReviewReady = (async () => {
  'use strict';
  if (!window.PdfSelectionDiff) await import('./pdf-selection-diff.js');
  await window.PdfSelectionDiff.loadMonaco();
  // Source/PDF mapping and candidate generation.
  const { textDiff, textEdits, significantText, changedRange, htmlFontDefinition,
    readPageText, readPageFonts, textItemFont } = window.PdfSelectionDiff;
  window.PdfReviewProvider = { createLocator, connectionDiff, reviewCandidates };
  function connectionDiff(source, target, connection) {
    return connection.editorDiff ||= textDiff(source.raw.slice(connection.start, connection.end),
      target.raw.slice(connection.targetStart, connection.targetEnd), true);
  }
  function reviewCandidates(index, targets = [], notice = null, selectedParts = null) {
    const items = [], seen = [];
    function claim(start, end) {
      let low = 0, high = seen.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (seen[middle].start < start) low = middle + 1; else high = middle;
      }
      if (seen[low]?.start === start || low && seen[low - 1].end > start
        || seen[low] && seen[low].start < end && seen[low].end > start) return false;
      seen.splice(low, 0, { start, end });
      return true;
    }
    const add = (start, parts, pdfRaw = '', pdfStart = 0) => {
      const projection = [];
      let left = start, right = pdfStart;
      for (const part of parts || []) {
        if (part.pdf.length) projection.push({ left, right, stop: right + part.pdf.length, part });
        left += part.html.length; right += part.pdf.length;
      }
      const project = (offset, endBias) => {
        let low = 0, high = projection.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (projection[middle].stop < offset) low = middle + 1; else high = middle;
        }
        const hit = projection[low];
        if (!hit) return left;
        if (!hit.part.changed) return hit.left + Math.max(0, offset - hit.right);
        if (offset <= hit.right) return hit.left;
        return endBias || offset === hit.stop ? hit.left + hit.part.html.length : hit.left;
      };
      for (const part of parts || []) {
        const end = start + part.html.length, id = `${start}:${end}`;
        if (part.changed && significantText(part.html, index, start) !== significantText(part.pdf) && claim(start, end)) {
          const lineStart = pdfRaw.lastIndexOf('\n', Math.max(0, pdfStart - 1)) + 1;
          const nextLine = pdfRaw.indexOf('\n', pdfStart + part.pdf.length);
          const lineEnd = nextLine < 0 ? pdfRaw.length : nextLine;
          let a = pdfRaw ? Math.min(start, project(lineStart, false)) : index.raw.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
          let b = pdfRaw ? Math.max(end, project(lineEnd, true)) : index.raw.indexOf('\n', end);
          if (b < 0) b = index.raw.length;
          a = Math.max(0, a);
          b = Math.min(index.raw.length, b);
          const html = index.raw.slice(a, b);
          const preview = { html, pdf: index.raw.slice(a, start) + part.pdf + index.raw.slice(end, b) };
          items.push({ id, sourceStart: start, sourceEnd: end, preview,
            comparison: { html: part.html, pdf: part.pdf }, options: [
              { id: 'pdf', label: '替换', edits: textEdits(index, start, end, part.pdf) }
            ] });
        }
        start = end;
        pdfStart += part.pdf.length;
      }
    };
    for (const target of targets.filter(Boolean)) for (const connection of index.connections.get(target) || [])
      add(connection.start, connectionDiff(index, target, connection)?.parts, target.raw, connection.targetStart);
    if (notice?.source && index.raw.slice(notice.source.start, notice.source.end) === notice.html) {
      add(notice.source.start, selectedParts || textDiff(notice.html, notice.pdf, true)?.parts);
    }
    return items.sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd);
  }
  function createLocator(options = {}, environment = {}) {
    const documents = new WeakMap(), sourceIndexes = new WeakMap(), noPdf = {};
    const reviewAnchors = new WeakMap();
    const document = environment.document || window.document;
    return { sourceIndex, editorSourceIndex, sourcePageScope, normalized, matches, locate,
      normalizedRange, approximateMatches, lowerBound, rememberConnection, patchedWords,
      connectedRange, reviewAnchor, indexDocument, indexFonts, getDocumentIndex, prepareSource };
    function sourceIndex(source) {
      const template = document.createElement("template"), starts = [], ends = [], formats = [];
      const stack = [{ name: '', italic: false, bold: false, tags: [] }];
      let raw = "", ignored = "";
      const tokens = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);|[^<&]+|[<&]/gi;
      for (const token of source.matchAll(tokens)) {
        const text = token[0], tag = /^<(\/?)\s*([a-z][\w:-]*)/i.exec(text);
        if (ignored) {
          if (tag?.[1] && tag[2].toLowerCase() === ignored) ignored = "";
          continue;
        }
        let value = text, encoded = false;
        if (tag) {
          const name = tag[2].toLowerCase();
          if (!tag[1] && /^(head|script|style)$/.test(name)) ignored = name;
          if (tag[1]) {
            const at = stack.findLastIndex(value => value.name === name);
            if (at > 0) {
              Object.assign(stack[at].definition, { closeStart: token.index, closeEnd: token.index + text.length, closing: text, rawEnd: raw.length });
              stack.length = at;
            }
          } else if (!ignored && !/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name) && !/\/\s*>$/.test(text)) {
            const inherited = stack.at(-1);
            const definition = htmlFontDefinition(name, text, raw.length, token.index);
            stack.push({ name, definition, italic: definition.italic ?? inherited.italic, bold: definition.bold ?? inherited.bold,
              tags: definition.italic !== null || definition.bold !== null ? [...inherited.tags, definition] : inherited.tags });
          }
          value = (tag[1] && /^(p|div|li|h[1-6])$/.test(name)) || name === "br" ? "\n" : "";
          encoded = true;
        } else if (text.startsWith("<!")) value = "";
        else if (text.startsWith("&") && text.endsWith(";")) {
          template.innerHTML = text;
          value = template.content.textContent;
          encoded = value !== text;
        }
        raw += value;
        for (let i = 0; i < value.length; i++) {
          starts.push(token.index + (encoded ? 0 : i));
          ends.push(token.index + (encoded ? text.length : i + 1));
          formats.push(stack.at(-1));
        }
      }
      return { source, raw, starts, ends, formats, normalized: normalized(raw), pageScopes: new WeakMap(), connections: new WeakMap() };
    }
    function editorSourceIndex(model, targets = []) {
      // One source snapshot per model/PDF pair, shared by selection and review.
      let pairs = sourceIndexes.get(model);
      if (!pairs) sourceIndexes.set(model, pairs = new WeakMap());
      const pdf = environment.getPdf?.() || noPdf;
      const previous = pairs.get(pdf), version = model.getVersionId?.();
      if (version !== undefined && previous?.version === version) return previous;
      const source = model.getValue();
      if (previous?.source === source && previous.version === version) return previous;
      const index = { version, ...sourceIndex(source) };
      if (previous) {
        const { start, oldEnd, newEnd } = changedRange(previous.raw, index.raw);
        const shift = range => range && (range.end <= start ? 0 : range.start >= oldEnd ? newEnd - oldEnd : null);
        // Keep confirmed, unchanged passages; only edited passages need a new diff.
        for (const target of new Set([...targets, ...(environment.getTargets?.() || []), getDocumentIndex(pdf)].filter(Boolean))) {
          const retained = (previous.connections.get(target) || []).flatMap(item => {
            const delta = shift(item);
            return delta === null ? [] : [{ ...item, start: item.start + delta, end: item.end + delta }];
          });
          if (retained.length) index.connections.set(target, retained);
          const reverse = (target.connections?.get(previous) || []).flatMap(item => {
            const delta = shift({ start: item.targetStart, end: item.targetEnd });
            return delta === null ? [] : [{ ...item, targetStart: item.targetStart + delta, targetEnd: item.targetEnd + delta }];
          });
          if (reverse.length) target.connections.set(index, reverse);
          const cached = previous.pageScopes.get(target), delta = shift(cached?.scope);
          if (cached?.scope && delta !== null) index.pageScopes.set(target, {
            ...cached, scope: { ...cached.scope, start: cached.scope.start + delta, end: cached.scope.end + delta }
          });
          // Formatting edits retain the same text coordinates in both directions.
          // Reuse the reverse scope too, so prepareSource does not rematch the volume.
          if (previous.raw === index.raw) {
            const reverseScope = target.pageScopes?.get(previous);
            if (reverseScope) target.pageScopes.set(index, reverseScope);
          }
        }
      }
      pairs.set(pdf, index);
      return index;
    }
    function reviewAnchor(item, currentIndex) {
      const source = item?.pdfSource;
      if (!source) return null;
      let anchors = reviewAnchors.get(item);
      if (!anchors) reviewAnchors.set(item, anchors = new WeakMap());
      // Read the candidate's confirmed diff, including after its HTML offsets move.
      // Popup layout must never search again or prepare another source mapping.
      for (const { index } of environment.getVisiblePages?.() || []) {
        if (!index?.layer?.isConnected) continue;
        const connections = source.index.connections.get(index), currentConnections = currentIndex?.connections.get(index);
        let cached = anchors.get(index);
        if (!cached || cached.connections !== connections || cached.currentIndex !== currentIndex || cached.currentConnections !== currentConnections) {
          const hit = connectedRange(source.index, index, source.start, source.end, false, undefined, true)
            || currentIndex && currentIndex !== source.index && connectedRange(currentIndex, index, item.sourceStart, item.sourceEnd, false, undefined, true);
          cached = { connections, currentIndex, currentConnections, hit };
          anchors.set(index, cached);
        }
        const hit = cached.hit;
        if (!hit) continue;
        const layer = index.layer.getBoundingClientRect();
        if (cached.bounds) return { left: layer.left + cached.bounds.left * layer.width,
          top: layer.top + cached.bounds.top * layer.height, bottom: layer.top + cached.bounds.bottom * layer.height };
        const end = index.raw.slice(hit.start, hit.end).trim() ? hit.end : hit.start;
        const first = Math.min(index.parts.length - 1, lowerBound(index.parts, hit.start + 1, part => part.end));
        const last = hit.start === end ? first : lowerBound(index.parts, end, part => part.end);
        const bounds = { left: Infinity, top: Infinity, bottom: -Infinity };
        const range = document.createRange();
        for (const part of index.parts.slice(first, last + 1)) {
          range.setStart(part.node, Math.max(0, Math.min(part.node.length, hit.start - part.start)));
          range.setEnd(part.node, Math.max(0, Math.min(part.node.length, end - part.start)));
          for (const box of range.getClientRects()) if (box.height) {
            bounds.left = Math.min(bounds.left, box.left);
            bounds.top = Math.min(bounds.top, box.top);
            bounds.bottom = Math.max(bounds.bottom, box.bottom);
          }
        }
        if (bounds.bottom !== -Infinity) {
          if (layer.width && layer.height) cached.bounds = { left: (bounds.left - layer.left) / layer.width,
            top: (bounds.top - layer.top) / layer.height, bottom: (bounds.bottom - layer.top) / layer.height };
          return bounds;
        }
      }
      return null;
    }
    function sourcePageScope(index, page, connect = false) {
      const cached = index.pageScopes.get(page);
      if (cached && (!connect || cached.prepared)) return cached.scope;
      let scope = locate(index.raw, { text: page.raw, before: "", after: "" }, index.normalized);
      if (scope && connect) rememberConnection(index, scope.start, scope.end, page, { start: 0, end: page.raw.length });
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
                  previous.end = range.end;
                  previous.hit.end = range.hit.end;
                  previous.distance += distance;
                } else confirmed.push({ ...range, distance });
              }
            }
            for (const range of confirmed) {
              let a = lowerBound(from.starts, range.start), b = lowerBound(from.ends, range.end) + 1,
                x = lowerBound(to.starts, range.hit.start), y = lowerBound(to.ends, range.hit.end) + 1;
              // Extend confirmed passages through matching edges, never estimated context padding.
              while (a && x && from.text[a - 1] === to.text[x - 1]) { a--; x--; }
              while (b < from.text.length && y < to.text.length && from.text[b] === to.text[y]) { b++; y++; }
              rememberConnection(index, to.starts[x], to.ends[y - 1], page, { start: from.starts[a], end: from.ends[b - 1] });
            }
          }
          if (anchors.every((anchor, i) => !i || anchor.start > anchors[i - 1].start)) {
            const first = anchors[0], last = anchors.at(-1), mapped = index.normalized;
            const start = Math.max(0, first.start - first.at - 32), end = Math.min(mapped.text.length, last.end + text.length - last.at - size + 32);
            scope = { start: mapped.starts[start], end: mapped.ends[end - 1] };
            // Context padding must stay within the PDF pages confirmed by the anchors.
            const firstPage = index.pages?.find(page => mapped.starts[first.start] >= page.start && mapped.starts[first.start] < page.end);
            const lastPage = index.pages?.find(page => mapped.starts[last.end - 1] >= page.start && mapped.starts[last.end - 1] <= page.end);
            if (firstPage) scope.start = Math.max(scope.start, firstPage.start);
            if (lastPage) scope.end = Math.min(scope.end, lastPage.end);
          }
        }
      }
      if (scope) {
        scope.normalized = normalizedRange(index, scope.start, scope.end);
      }
      if (!scope && connect) scope = sourcePageScope(index, page);
      index.pageScopes.set(page, { scope, prepared: connect });
      return scope;
    }
    function anchorMatches(index, needle) {
      // Index aligned 16-character blocks to find 32-character anchors without full rescans.
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
    function normalized(raw, result = { text: "", starts: [], ends: [] }, base = 0) {
      let previous = result.text.at(-1) || "";
      const units = [], { starts, ends } = result;
      for (const match of raw.matchAll(/((?<=[\p{L}\p{N}])[-\u2010\u2011]\s*\n\s*(?=[\p{L}\p{N}]))|[\s\S]/gu)) {
        const char = match[0], start = base + match.index, offset = start + char.length;
        if (match[1] || char === "\u00ad") continue;
        const value = char.normalize("NFKC").toLowerCase().replace(/ſ/g, "s").replace(/ß/g, "ss")
          .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/\s/g, " ");
        for (const unit of value) {
          if (unit === " " && previous === " ") {
            ends[ends.length - 1] = offset;
            continue;
          }
          units.push(unit); previous = unit;
          for (let i = 0; i < unit.length; i++) { starts.push(start); ends.push(offset); }
        }
      }
      result.text += units.join("");
      return result;
    }
    function matches(raw, queries, haystack = normalized(raw)) {
      const found = new Map(), word = char => !!char && /[\p{L}\p{N}_]/u.test(char);
      for (const query of queries) {
        const needle = normalized(query).text.trim();
        if (!needle) continue;
        let at = 0;
        while ((at = haystack.text.indexOf(needle, at)) !== -1) {
          const end = at + needle.length;
          const before = [...haystack.text.slice(Math.max(0, at - 2), at)].pop(), after = [...haystack.text.slice(end, end + 2)][0];
          if (!options.wholeWords || ((!word(needle[0]) || !word(before)) && (!word([...needle].pop()) || !word(after)))) {
            const start = haystack.starts[at], stop = haystack.ends[end - 1];
            found.set(`${start}:${stop}`, { start, end: stop });
          }
          at++;
        }
      }
      return [...found.values()];
    }
    function normalizedRange(index, start, end) {
      return start === 0 && end === index.raw.length && index.normalized
        ? index.normalized : normalized(index.raw.slice(start, end));
    }
    function locate(raw, entry, haystack = normalized(raw), fuzzyOnly = false) {
      const before = normalized(entry.before).text.trim(), after = normalized(entry.after).text.trim();
      const exact = fuzzyOnly ? [] : matches(raw, [entry.text], haystack);
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
      if (required && best.score < required) return exact.length ? locate(raw, entry, haystack, true) : null;
      return tied ? null : best;
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
      const left = alignment?.left || normalizedRange(source, start, end),
        right = alignment?.right || normalizedRange(target, hit.start, hit.end);
      if (!left.text && !right.text) return null;
      const diff = alignment?.diff || textDiff(left.text, right.text, true, 128);
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
      for (const connection of entry.index?.connections.get(target) || []) for (const [from, to] of connection.patches)
        patches.set(from, patches.has(from) && patches.get(from) !== to ? null : to);
      const text = normalized(entry.text).text.replace(/[\p{L}\p{N}]+/gu, word => patches.get(word) || word);
      return [...new Set(text.match(/[\p{L}\p{N}]+(?:[-/'\\][\p{L}\p{N}]+)*/gu) || [])];
    }
    function connectedRange(source, target, start, end, reverse = false, connection, marked = false) {
      connection ||= (source.connections.get(target) || []).find(item => start >= (reverse ? item.targetStart : item.start)
        && end <= (reverse ? item.targetEnd : item.end));
      if (!connection || start > end) return null;
      const needsRaw = (marked || start === end) && !reverse;
      const raw = needsRaw && connectionDiff(source, target, connection);
      if (needsRaw && !raw) return null;
      const from = reverse ? connection.right : connection.left, to = reverse ? connection.left : connection.right;
      const offset = reverse ? connection.targetStart : connection.start,
        targetOffset = reverse ? connection.start : connection.targetStart;
      const a = raw ? start - offset : lowerBound(from.ends, start - offset + 1),
        b = raw ? end - offset : lowerBound(from.starts, end - offset);
      let first = Infinity, last = -1, cursorA = 0, cursorB = 0;
      for (const span of raw ? raw.parts : connection.spans) {
        const left = cursorA, right = cursorA += span[reverse ? 'pdf' : 'html'].length,
          targetLeft = cursorB, targetRight = cursorB += span[reverse ? 'html' : 'pdf'].length;
        if (raw && a === b ? !span.changed || right !== a || left !== a
          && !(marked && !span.html.trim() && significantText(span.pdf)) : right <= a || left >= b) continue;
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
      // Search alignment folds case; review must compare the original mapped text.
      const selected = (reverse ? target : source).raw.slice(start, end),
        mapped = (reverse ? source : target).raw.slice(hit.start, hit.end);
      hit.approximate = significantText(selected) !== significantText(mapped);
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
          const page = await pdf.getPage(number), content = await readPageText(page);
          if (!environment.isCurrent(pdf)) return null;
          const start = raw.length, parts = [];
          let previous = null, pageRaw = "";
          for (const item of content.items.filter(item => item.str?.trim()).sort((a, b) =>
            Math.round((b.transform[5] - a.transform[5]) / Math.max(a.height, b.height)) || a.transform[4] - b.transform[4])) {
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
      })().catch(error => {
        documents.delete(pdf);
        throw error;
      });
      const index = await cached.task;
      if (!index) documents.delete(pdf);
      return index;
    }
    function getDocumentIndex(pdf) { return documents.get(pdf)?.index; }
    async function indexFonts(pdf, source, signal) {
      const index = await indexDocument(pdf);
      if (!index || signal?.aborted) return null;
      const ranges = source?.connections.get(index);
      for (const entry of index.pages) {
        if (source && !ranges?.some(hit => hit.targetStart < entry.end && hit.targetEnd > entry.start)
          || entry.parts.every(part => part.font)) continue;
        if (signal?.aborted || !environment.isCurrent(pdf)) return null;
        // Share in-flight work too; separate reviews can request the same page.
        await (entry.fontTask ||= (async () => {
          await environment.waitForIdle(pdf);
          if (!environment.isCurrent(pdf)) return;
          const page = await pdf.getPage(entry.number);
          if (!environment.isCurrent(pdf)) return;
          const fonts = await readPageFonts(page, entry.parts.map(part => part.item));
          if (!environment.isCurrent(pdf)) return;
          for (const part of entry.parts) part.font = textItemFont(fonts, part.item);
          index.fontVersion = (index.fontVersion || 0) + 1;
        })().finally(() => { entry.fontTask = null; }));
      }
      return !signal?.aborted && environment.isCurrent(pdf) ? index : null;
    }
    function prepareSource(source, pages, pdf) {
      if (!source) return;
      pages = [...new Set([...pages, ...(environment.getTargets?.() || [])])].filter(Boolean);
      const full = getDocumentIndex(pdf);
      const prepared = source.preparation;
      if (prepared && prepared.pdf === pdf && prepared.full === full && prepared.pages.length === pages.length
        && pages.every((page, i) => page === prepared.pages[i] && source.connections.get(page) === prepared.connections[i])) return;
      if (full && source.preparedDocument !== full) {
        sourcePageScope(full, source, true);
        for (const item of full.connections.get(source) || [])
          rememberConnection(source, item.targetStart, item.targetEnd, full, { start: item.start, end: item.end }, {
            left: item.right, right: item.left, diff: { distance: item.distance,
              parts: item.spans.map(span => ({ html: span.pdf, pdf: span.html, changed: span.changed })) }
          });
        source.preparedDocument = full;
      }
      for (const page of pages) if (page !== source.preparedDocument) sourcePageScope(source, page, true);
      // Prefer whole-passage mappings over shorter quotations on adjacent pages.
      const connections = pages.flatMap(page =>
        (source.connections.get(page) || []).map(connection => ({ page, connection })));
      for (const page of pages) {
        const previous = source.connections.get(page) || [];
        const retained = previous.filter(item => !connections.some(other => other.page !== page
          // Whole-document text extraction does not carry the rendered page's fonts.
          && other.page !== full
          && other.connection.start <= item.start && other.connection.end >= item.end
          && other.connection.end - other.connection.start > item.end - item.start));
        if (retained.length !== previous.length) source.connections.set(page, retained);
      }
      source.preparation = { pdf, full, pages, connections: pages.map(page => source.connections.get(page)) };
      source.preparedPdf = pdf;
    }
  }
  // Shared popup and session initialization.
  if (!window.ReplacementReview || !window.ReviewHighlights) await import('./replacement-review.js');

  // PDF comparison is one review provider. Selection synchronization remains independent.
  const host = window.ReplacementReview, toolbox = window.PdfSelectionDiff, mapping = window.PdfReviewProvider;
  let enabled = true, fontEnabled = true;
  try { enabled = localStorage.getItem('mew.pdf-review.enabled') !== 'false'; } catch {}
  try { fontEnabled = localStorage.getItem('mew.pdf-review.font-enabled') !== 'false'; } catch {}
  function readerWindow() {
    if (window.ReaderUI?.getPdfViewer) return window;
    try { if (window.opener && !window.opener.closed && window.opener.ReaderUI?.getPdfViewer) return window.opener; } catch {}
    return null;
  }
  const viewer = () => readerWindow()?.ReaderUI.getPdfViewer() || window.PdfSelection?.viewer;
  const selection = () => readerWindow()?.PdfSelection || window.PdfSelection;
  const fallbackLocator = mapping.createLocator({}, {
    document, getPdf: () => viewer()?.pdfDocument,
    isCurrent: pdf => viewer()?.pdfDocument === pdf,
    waitForIdle: () => new Promise(resolve => setTimeout(resolve, 0))
  });
  const getLocator = () => selection()?.locator || fallbackLocator;
  const highlights = window.ReviewHighlights.create({ document, lowerBound: fallbackLocator.lowerBound,
    classes: { selection: 'mew-pdf-selection-highlight', pointer: 'mew-pdf-review-pointer', caret: 'mew-pdf-selection-caret' } });
  const { measureHighlights, paintHighlight, clearHighlights, clearMarks } = highlights;
  function presentation(context, item) {
    const reader = readerWindow() || window, source = context.editor?.getDomNode()?.ownerDocument.defaultView || window;
    const split = source !== reader, side = split ? context.request?.side || 'html' : 'pdf';
    const request = context.request;
    const element = request?.anchorElement, box = request?.anchorBox;
    const rect = (!item || side !== 'pdf') && element?.isConnected && element.getBoundingClientRect();
    const anchor = item && side === 'pdf' ? getLocator().reviewAnchor(item, context.index) : rect && box ? { left: rect.left + box.x * rect.width, top: rect.top + box.y * rect.height,
      bottom: rect.top + (box.y + box.h) * rect.height } : request?.anchor;
    const destination = side === 'pdf' ? reader : source;
    return { side, switchable: split, switchLabel: side === 'pdf' ? '查看HTML' : '查看PDF', host: destination.ReplacementReview, window: destination,
      container: viewer()?.container, eventBus: viewer()?.eventBus, anchor };
  }
  const comparisonCache = new WeakMap();
  function comparisonParts(value) {
    let cached = comparisonCache.get(value);
    if (!cached || cached.html !== value.html || cached.pdf !== value.pdf) {
      cached = { html: value.html, pdf: value.pdf, parts: toolbox.textDiff(value.html, value.pdf, true)?.parts || [{ ...value, changed: false }] };
      comparisonCache.set(value, cached);
    }
    return cached.parts;
  }
  function comparisonRows(value, compact = true) {
    if (typeof value?.html !== 'string' || typeof value?.pdf !== 'string') return [];
    let parts = comparisonParts(value);
    if (compact) {
      const first = parts.findIndex(part => part.changed), last = parts.findLastIndex(part => part.changed);
      if (first >= 0) {
        // Keep every changed run, including unchanged text between distant edits.
        // Reuse the original character diff rather than computing it again on a crop.
        const before = parts.slice(0, first).map(part => part.html).join('');
        const after = parts.slice(last + 1).map(part => part.html).join('');
        const prefix = (before.length > 45 ? '…' : '') + before.slice(-45);
        const suffix = after.slice(0, 45) + (after.length > 45 ? '…' : '');
        parts = [...(prefix ? [{ html: prefix, pdf: prefix, changed: false }] : []),
          ...parts.slice(first, last + 1), ...(suffix ? [{ html: suffix, pdf: suffix, changed: false }] : [])];
      }
    }
    return ['html', 'pdf'].map(side => ({ label: side.toUpperCase(), parts: parts.map(part => {
      const missing = part.changed && !part[side].trim() && !!part[side === 'html' ? 'pdf' : 'html'].trim();
      return { text: missing ? '' : part[side], changed: part.changed };
    }) }));
  }
  function formatItems(index, targets = []) {
    if (!fontEnabled) return [];
    return toolbox.formatDifferences(index, targets.filter(Boolean)
      .flatMap(target => (index.connections.get(target) || []).map(connection => [connection, target, mapping.connectionDiff(index, target, connection)])));
  }
  const isCurrent = context => context.pdf === viewer()?.pdfDocument;
  async function provide(context) {
    const pdf = context.pdf = viewer()?.pdfDocument;
    if (!pdf) throw new Error('请先在对照阅读器中打开 PDF。');
    const request = context.request;
    if (request?.pdf === pdf && request.notice?.source?.index.source === context.source) {
      context.targets = [...new Set([request.notice.target?.index, ...(request.targets || [])].filter(Boolean))];
      context.index = request.notice.source.index;
      return reviewItems(context.index, context.targets, request.notice, context.model);
    }
    const full = await getLocator().indexDocument(pdf);
    if (context.signal.aborted) return [];
    if (!full || !isCurrent(context)) throw new Error('PDF 已变化，正在等待对照文件就绪。');
    const index = context.index = getLocator().editorSourceIndex(context.model);
    context.targets = [full];
    getLocator().prepareSource(index, context.targets, pdf);
    if (fontEnabled) await getLocator().indexFonts(pdf, index, context.signal);
    return context.signal.aborted || !isCurrent(context) ? [] : reviewItems(index, context.targets, null, context.model);
  }
  function refreshCandidates(context, offset) {
    const locator = getLocator(), index = context.index = locator.editorSourceIndex(context.model);
    locator.prepareSource(index, context.targets, context.pdf);
    const items = reviewItems(index, context.targets, null, context.model);
    const choices = new Map();
    let found = -1;
    for (const [position, item] of items.entries()) {
      choices.set(item.id, item.options[0].id);
      if (found < 0 && ((index.starts[item.sourceEnd] ?? context.source.length) > offset
        || (index.starts[item.sourceStart] ?? context.source.length) >= offset)) found = position;
    }
    return { items, choices, position: found < 0 ? items.length : found };
  }
  function reviewItems(index, targets, notice, model) {
    let text = enabled ? mapping.reviewCandidates(index, targets) : [];
    const selected = enabled && selectionCandidate(index, notice, model);
    if (selected) text = [...text.filter(item => item.sourceEnd <= selected.sourceStart && item.sourceStart < selected.sourceStart
      || item.sourceStart >= selected.sourceEnd && item.sourceEnd > selected.sourceEnd), selected].sort((a, b) => a.sourceStart - b.sourceStart);
    const formats = formatItems(index, targets);
    const positions = new Map();
    let cursor = 0;
    for (const item of formats) {
      item.range = toolbox.rangeAt(model, index.starts[item.sourceStart], index.ends[item.sourceEnd - 1]);
      while (cursor < text.length && text[cursor].sourceEnd < item.sourceStart) cursor++;
      const nearby = text[cursor];
      positions.set(item, nearby && nearby.sourceStart <= item.sourceEnd ? nearby.sourceStart : item.sourceStart);
    }
    const order = item => positions.get(item) ?? item.sourceStart;
    return [...text, ...formats].sort((a, b) => order(a) - order(b) || Number(!!a.font) - Number(!!b.font))
      .map(item => ({ ...item, pdfSource: { index, start: item.sourceStart, end: item.sourceEnd } }));
  }
  function selectionCandidate(index, notice, model) {
    const source = notice?.source;
    if (!source) return null;
    const selected = mapping.reviewCandidates(index, [], notice, comparisonParts(notice));
    if (!selected.length) return null;
    return { id: `${source.start}:${source.end}`, sourceStart: source.start, sourceEnd: source.end,
      selection: true, comparison: notice,
      range: toolbox.rangeAt(model, index.starts[source.start] ?? index.source.length,
        index.ends[source.end - 1] ?? index.starts[source.start] ?? index.source.length),
      options: [{ id: 'pdf', label: '替换', edits: selected.flatMap(item => item.options[0].edits) }] };
  }
  function content(state, item) {
    const edits = item?.options[0].edits || [], formats = item?.formats || [item];
    const message = item?.font ? ['italic', 'bold'].flatMap(key => [...new Set(formats.filter(value => typeof value.font[key] === 'boolean'
      && value.font[key] !== value.htmlFont[key]).map(value =>
        `${key === 'italic' ? '斜体' : '粗体'}不一致（HTML ${value.htmlFont[key] ? '是' : '否'} / PDF ${value.font[key] ? '是' : '否'}${key === 'bold' && value.font.scanBoldRatio ? '，扫描估计' : ''}）`))]).join('；')
      : item ? '文字不一致' : state.items.length ? '已到末尾，可返回上一条。' : '没有可审阅的差异。';
    return { message,
      comparison: item?.font ? [] : comparisonRows(item?.preview || item?.comparison, !item?.selection),
      apply: !item?.font || !!edits.length,
      range: item?.range || (edits.length ? toolbox.rangeAt(state.model, Math.min(...edits.map(edit => edit.start)), Math.max(...edits.map(edit => edit.end))) : null),
      options: [], applyLabel: item?.font ? '替换格式' : '替换', advance: false, expanded: false };
  }
  const pattern = (value, index) => {
    // Without source context, only the selected candidate may match itself.
    if (!index || !Number.isInteger(value.sourceStart) || !Number.isInteger(value.sourceEnd)) return value;
    const { raw } = index, start = value.sourceStart, end = value.sourceEnd;
    let before = start, after = end;
    const word = /^[\p{L}\p{M}\p{N}_'’\-]+$/u;
    while (before > 0 && word.test(raw.slice(before - (raw.codePointAt(before - 2) > 0xffff ? 2 : 1), before)))
      before -= raw.codePointAt(before - 2) > 0xffff ? 2 : 1;
    while (after < raw.length && word.test(String.fromCodePoint(raw.codePointAt(after))))
      after += raw.codePointAt(after) > 0xffff ? 2 : 1;
    const prefix = raw.slice(before, start), suffix = raw.slice(end, after);
    if ([...raw.slice(before, after)].length < 2
      && [...(prefix + (value.comparison?.pdf ?? value.text ?? '') + suffix)].length < 2) return value;
    return JSON.stringify([!!value.font, ...(value.font ? [value.text,
      ...['italic', 'bold'].flatMap(key => [value.htmlFont[key], value.font[key]])] : [value.comparison?.html, value.comparison?.pdf]),
      prefix, suffix]);
  };
  function apply(state, all) {
    const item = state.items[state.position];
    if (all || item?.font) getLocator().prepareSource(state.context.index, state.context.targets, state.context.pdf);
    const key = item && pattern(item, state.context.index), selected = all ? state.items
      : state.items.filter(value => pattern(value, state.context.index) === key);
    const edits = [], formats = [];
    for (const value of selected) {
      if (value.font) formats.push(value);
      else edits.push(...value.options[0].edits);
    }
    if (formats.length) for (const candidate of formatItems(state.context.index, state.context.targets))
      if (formats.some(value => candidate.sourceStart < value.sourceEnd && candidate.sourceEnd > value.sourceStart))
        edits.push(...candidate.options[0].edits);
    const checked = toolbox.validateEdits(state.source, edits);
    const offset = state.context.index.starts[item.sourceStart] ?? state.source.length;
    const shifted = offset + checked.reduce((delta, edit) => delta + (edit.end <= offset
      ? edit.text.length - (edit.end - edit.start) : 0), 0);
    toolbox.applyEdits(state.editor, state.model, state.version, state.source, checked);
    const source = state.model.getValue();
    const context = { ...state.context, source, version: state.model.getVersionId?.() };
    // Regenerate ranges and expected text from the new source, including overlapping format changes.
    return { ...refreshCandidates(context, shifted), context };
  }

  const review = {
    compact: true, content, apply, presentation, isCurrent, provide,
    refreshAfterEdit: refreshCandidates,
    onSelect(item, context, items) { const key = pattern(item, context.index);
      selection()?.showReviewPointer(context.editor, items.filter(value => pattern(value, context.index) === key)); },
    onClose(context) { selection()?.clearReviewPointer(context.editor); }
  };
  const unregister = [host.register({
    ...review,
    id: 'pdf-ocr', label: 'PDF 文字差异审阅', isEnabled: () => enabled,
    focusIndex(items, request) {
      const offset = request?.notice?.source?.start;
      if (offset === undefined) return -1;
      const found = items.findIndex(item => !!item.font === (request?.kind === 'font')
        && (item.sourceEnd > offset || item.sourceStart >= offset));
      return found < 0 ? items.length - 1 : found;
    },
    containsSelection(item, request) {
      const source = request?.notice?.source;
      return source && item && item.sourceStart === source.start && item.sourceEnd === source.end;
    },
    setEnabled(value) {
      enabled = value;
      try { localStorage.setItem('mew.pdf-review.enabled', String(value)); } catch {}
      host.invalidate('pdf-font');
    }
  }), host.register({
    ...review,
    id: 'pdf-font', label: 'PDF 斜体／粗体探测',
    isEnabled: () => fontEnabled,
    setEnabled(value) {
      fontEnabled = value;
      try { localStorage.setItem('mew.pdf-review.font-enabled', String(value)); } catch {}
      host.invalidate('pdf-ocr');
    },
    focusIndex(items, request) {
      const start = request?.notice?.source?.start;
      return start === undefined ? -1 : items.findIndex(item => item.sourceEnd > start);
    },
    containsSelection(item, request) {
      const source = request?.notice?.source;
      return source && item.sourceStart < source.end && item.sourceEnd > source.start;
    }
  }), host.register({
    id: 'pdf-selection', label: 'PDF 与源码差异高亮', available: () => !!selection(),
    isEnabled: () => selection()?.enabled === true,
    setEnabled(value) { selection()?.setDiffHighlight(value); }
  }), host.register({
    id: 'pdf-selection-sync', label: 'PDF 与源码选区联动', available: () => !!selection(),
    isEnabled: () => selection()?.selectionEnabled === true,
    setEnabled(value) { selection()?.setSelectionHighlight(value); }
  })];
  function sourceDecorations(index, connections, model) {
    const decorations = [], seen = new Set(), comparisons = [];
    const add = (segments, prefix, options) => {
      for (const { start, end } of segments) {
        const key = `${prefix}${start}:${end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        decorations.push({ range: toolbox.rangeAt(model, start, end), options: {
          linesDecorationsClassName: 'mew-ocr-diff-line', stickiness: 1, ...options
        } });
      }
    };
    for (const [connection, target] of connections) {
      let cursor = connection.start;
      const diff = mapping.connectionDiff(index, target, connection);
      comparisons.push([connection, target, diff]);
      for (const part of diff?.parts || []) {
        const end = cursor + part.html.length;
        if (part.changed && toolbox.significantText(part.html, index, cursor) !== toolbox.significantText(part.pdf)) {
          const escape = text => JSON.stringify(text.trim() ? text : '').replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, '\\$&');
          const segments = toolbox.sourceSegments(index, cursor, end);
          const insertion = !segments.length;
          if (insertion) segments.push(toolbox.insertionSegment(index, end));
          add(segments, '', {
            description: 'PDF OCR text difference',
            inlineClassName: insertion ? undefined : 'mew-ocr-diff-text',
            beforeContentClassName: insertion ? 'mew-ocr-diff-insert' : undefined,
            hoverMessage: { value: 'HTML: ' + escape(part.html) + '\n\nOCR: ' + escape(part.pdf), isTrusted: false },
            linesDecorationsTooltip: 'Text differs from PDF OCR'
          });
        }
        cursor = end;
      }
    }
    for (const item of toolbox.formatDifferences(index, comparisons)) {
      const formats = item.formats || [item];
      add(toolbox.sourceSegments(index, item.sourceStart, item.sourceEnd, true), 'font:', {
        description: 'PDF font difference', inlineClassName: 'mew-ocr-diff-text mew-font-diff-text',
        hoverMessage: { value: `HTML ${toolbox.fontSummary(formats.map(value => value.htmlFont))}\n\nPDF ${toolbox.fontSummary(formats.map(value => value.font))}`, isTrusted: false },
        linesDecorationsTooltip: '粗体／斜体与 PDF 不一致'
      });
    }
    return decorations;
  }
  function onSources(event) {
    const { editor, index, targets, enabled } = event.detail;
    if (!editor?.createDecorationsCollection) return;
    if (index) getLocator().prepareSource(index, targets, event.detail.pdf);
    const connections = index ? targets.flatMap(target => (index.connections.get(target) || []).map(item => [item, target])) : [];
    const key = [index, enabled, editor.getModel(), ...connections.flatMap(([item, target]) => [item, target, target.fontVersion])];
    highlights.updateSource(editor, key, () => enabled && index ? sourceDecorations(index, connections, editor.getModel()) : [],
      '.mew-ocr-diff-line{border-left:3px solid #d58b24;margin-left:3px;cursor:pointer}.mew-ocr-diff-text{background:rgba(255,166,40,.3);border-bottom:1px solid #d58b24;cursor:pointer}.mew-ocr-diff-insert{border-left:2px solid #d58b24;margin-left:-1px;cursor:pointer}');
  }
  Object.assign(mapping, {
    measureHighlights, paintHighlight, clearHighlights,
    getHighlight: highlights.getHighlight,
    readPageFonts: toolbox.readPageFonts,
    layerFonts: toolbox.layerFonts,
    selectionRange: highlights.selectionRange
  });
  // The independent selection module publishes data, never review UI calls.
  let listeningWindow = null;
  let dismissed = null;
  function onClose(event) {
    if (!['pdf-ocr', 'pdf-font'].includes(event.detail.id)) return;
    const { editor, model } = event.detail;
    dismissed = { editor, model, version: model.getVersionId?.(), range: editor.getSelection()?.toString(), interaction: selection()?.interactionId };
  }
  window.addEventListener('replacement-review-closed', onClose);
  function onDifference(event) {
    if (!enabled && !fontEnabled) return;
    const data = event.detail, editor = data.editor, model = editor?.getModel();
    const readerHost = listeningWindow?.ReplacementReview;
    const destination = ['pdf-ocr', 'pdf-font'].some(id => readerHost?.isOpenFor(id, editor)) ? readerHost
      : editor?.getDomNode()?.ownerDocument.defaultView.ReplacementReview || readerHost;
    if (destination !== host || data.pdf !== viewer()?.pdfDocument || (data.model && model !== data.model)) return;
    if (dismissed?.editor === editor && dismissed.model === model && dismissed.version === model?.getVersionId?.()
      && dismissed.range === editor?.getSelection()?.toString() && dismissed.interaction === data.interactionId) return;
    dismissed = null;
    const changed = data.notices.find(value => typeof value.html === 'string' && typeof value.pdf === 'string'
      && comparisonParts(value).some(part => part.changed));
    const notice = changed || data.notices.find(value => value.source) || data.notices[0];
    if (!notice || notice.source && model && notice.source.index.source !== model.getValue()) return;
    if (!changed) {
      if (notice.source && model) {
        const index = notice.source.index;
        const targets = [...new Set([notice.target?.index, ...(data.targets || [])].filter(Boolean))];
        // Compare the selected PDF layer even before background page mapping
        // has populated the source's connections (including exact text hits).
        if (notice.target && getLocator().normalized(index.raw.slice(notice.source.start, notice.source.end)).text
          === getLocator().normalized(notice.target.index.raw.slice(notice.target.start, notice.target.end)).text) {
          getLocator().rememberConnection(index, notice.source.start, notice.source.end, notice.target.index,
            { start: notice.target.start, end: notice.target.end });
        }
        const differences = formatItems(index, targets);
        const item = differences.find(item => item.sourceStart < notice.source.end && item.sourceEnd > notice.source.start);
        if (item) {
          void host.openForSelection(enabled ? 'pdf-ocr' : 'pdf-font', editor, item.id,
            { ...data, targets, notice, kind: 'font' }); return;
        }
      }
      return;
    }
    if (!enabled) return;
    if (!notice.source || !model) {
      host.showNotice({ title: 'PDF 文字差异', message: '文字不一致', comparison: comparisonRows(notice, false), anchor: data.anchor,
        layout: presentation({ editor, request: data }) }); return;
    }
    void host.openForSelection('pdf-ocr', editor, `${notice.source.start}:${notice.source.end}`, { ...data, notice });
  }
  function bind() {
    const target = readerWindow() || window;
    if (target === listeningWindow) return;
    listeningWindow?.removeEventListener('pdf-selection-difference', onDifference);
    // Only the reader owns decorations, including those in its paired editor.
    if (listeningWindow === window) {
      window.removeEventListener('pdf-selection-sources', onSources);
      window.removeEventListener('pdf-selection-reset', clearMarks);
      clearMarks();
    }
    listeningWindow = target; target.addEventListener('pdf-selection-difference', onDifference);
    if (target === window) {
      window.addEventListener('pdf-selection-sources', onSources);
      window.addEventListener('pdf-selection-reset', clearMarks);
    }
  }
  bind();
  let previousPdf = viewer()?.pdfDocument, previousApi = selection(), previousEnabled = previousApi?.enabled;
  const poll = setInterval(() => {
    bind();
    const pdf = viewer()?.pdfDocument, api = selection(), state = api?.enabled;
    if (previousPdf !== pdf) {
      previousPdf = pdf;
      for (const id of ['pdf-ocr', 'pdf-font']) host.invalidate(id, context => context.pdf !== pdf);
    }
    if (previousApi !== api || previousEnabled !== state) {
      previousApi = api; previousEnabled = state; host.refreshMenu();
    }
  }, 500);
  window.addEventListener('pagehide', () => { clearInterval(poll); highlights.dispose(); window.removeEventListener('pdf-selection-sources', onSources); window.removeEventListener('pdf-selection-reset', clearMarks); listeningWindow?.removeEventListener('pdf-selection-difference', onDifference); window.removeEventListener('replacement-review-closed', onClose); unregister.forEach(dispose => dispose()); });
  return window.PdfReviewProvider;
})();
