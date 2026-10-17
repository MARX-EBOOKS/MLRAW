// Shared review toolbox: PDF/source mapping, Monaco diff and guarded replacements.
(() => {
  "use strict";
  let computer = null, monacoTask = null;
  const fontPages = new WeakMap(), pageTexts = new WeakMap();
  window.PdfSelectionDiff = {
    localTextDiff, textDiff, sourceDecorations, createLocator, fontStyle, fontRuns, fontSummary, formatDifferences, readPageFonts, readPageText, textItemFont,
    textEdits, validateEdits, previewEdits, applyEdits, rangeAt, reviewCandidates, significantText, changedRange,
    get monacoAvailable() { return !!computer; },
    monacoDiff: (left, right) => textDiff(left, right, true, Infinity, true),
    useMonaco(value) { computer = value; },
    loadMonaco() {
      if (computer) return Promise.resolve(true);
      return monacoTask ||= import("/monaco/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js")
        .then(({ DefaultLinesDiffComputer }) => { computer ||= new DefaultLinesDiffComputer(); return true; })
        .catch(() => { monacoTask = null; return false; });
    }
  };
  // Share extraction across review, indexing and rendered-layer font inspection.
  // Failed requests are evicted so a subsequent interaction can retry.
  function readPageText(page) {
    if (!pageTexts.has(page)) pageTexts.set(page, Promise.resolve().then(() => page.getTextContent())
      .catch(error => { pageTexts.delete(page); throw error; }));
    return pageTexts.get(page);
  }

  function significantText(text) { return text.replace(/[\s\-\u00ad\u2010\u2011]/g, ''); }
  function changedRange(before, after) {
    let start = 0, oldEnd = before.length, newEnd = after.length;
    while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
    return { start, oldEnd, newEnd };
  }
  // PDF.js embeds intrinsic faces under generated CSS family names. CSS weight/style
  // alone therefore cannot distinguish a regular face from a bold/italic face.
  function fontStyle(font, fallback = '', css = {}) {
    const name = font?.name || fallback;
    // Tesseract's PDF renderer uses one placeholder face for all recognized words.
    // Its false style flags describe that placeholder, not the recognized text.
    if (/glyphlessfont/i.test(name)) return { name, italic: null, bold: null,
      reason: 'GlyphLessFont 占位字体未保留 OCR 粗斜体信息' };
    const italic = /italic|oblique/i.test(css.fontStyle || '') || (typeof font?.italic === 'boolean' ? font.italic : /italic|oblique|kursiv/i.test(name) ? true : null);
    const bold = /bold/i.test(css.fontWeight || '') || Number(css.fontWeight) >= 600 || font?.black === true
      || (typeof font?.bold === 'boolean' ? font.bold : /bold|black|heavy|demi|semibold|fett/i.test(name) ? true : null);
    return { name, italic, bold };
  }
  function fontItemKey(item) {
    return JSON.stringify([item.fontName, item.str, item.transform, item.width]);
  }
  function textItemFont(fonts, item) {
    return fonts?.get(fontItemKey(item)) || fonts?.get(item.fontName);
  }
  async function readPageFonts(page, items) {
    if (fontPages.has(page)) return fontPages.get(page);
    const task = (async () => {
      // Use PDF.js operators, not the CSS font chosen for the transparent text layer.
      const ops = window.pdfjsLib?.OPS || { save: 10, restore: 11, setFont: 37, setTextRenderingMode: 38,
        showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47 };
      const modes = new Map(), stack = [];
      let fontId = null, mode = 0, failed = false;
      try {
        const list = await page.getOperatorList?.();
        for (let i = 0; i < (list?.fnArray.length || 0); i++) {
          const fn = list.fnArray[i], args = list.argsArray[i];
          if (fn === ops.save) stack.push([fontId, mode]);
          else if (fn === ops.restore && stack.length) [fontId, mode] = stack.pop();
          else if (fn === ops.setFont) fontId = args[0];
          else if (fn === ops.setTextRenderingMode) mode = args[0];
          else if ([ops.showText, ops.showSpacedText, ops.nextLineShowText, ops.nextLineSetSpacingShowText].includes(fn)) {
            if (!modes.has(fontId)) modes.set(fontId, new Set());
            modes.get(fontId).add((mode & 3) === 3 ? 'invisible' : 'visible');
          }
        }
      } catch { failed = true; /* Text comparison remains available. */ }
      const fonts = new Map();
      for (const item of items) if (!fonts.has(item.fontName)) {
        const id = item.fontName, font = id && page.commonObjs?.has(id) ? page.commonObjs.get(id) : null;
        const style = fontStyle(font, id || '');
        if (failed) {
          style.bold = style.italic = null;
          style.reason = '字体读取失败';
        }
        if (!failed && modes.get(id)?.has('invisible')) {
          // Read retained OCR declarations (including non-embedded ABBYY faces).
          // Invisibility does not remove font style metadata; this is not a new
          // visual recognition of the scan. Placeholder faces remain unknown.
          style.declaredBold = style.bold; style.declaredItalic = style.italic;
          style.reason ||= 'OCR 字体';
        }
        fonts.set(id, style);
      }
      const textFonts = new Set(items.filter(item => item.str?.trim()).map(item => fonts.get(item.fontName)));
      const letters = items.reduce((sum, item) => sum + (item.str?.replace(/\s/g, '').length || 0), 0);
      const boldLetters = items.reduce((sum, item) => sum + (fonts.get(item.fontName)?.bold === true ? item.str?.replace(/\s/g, '').length || 0 : 0), 0);
      const dominantBold = letters > 0 && boldLetters / letters >= 0.8;
      for (const key of ['bold', 'italic']) {
        if (!textFonts.size || !(key === 'bold' && dominantBold) && ![...textFonts].every(font => font?.[key] === true)) continue;
        for (const font of textFonts) {
          if (font[key] !== true) continue;
          if (key === 'bold') font.declaredBold = true;
          font[key] = null;
          const reason = key === 'bold' && boldLetters < letters ? '大部分文字声明为粗体' : `均为${key === 'bold' ? '粗体' : '斜体'}`;
          font.reason = font.reason ? `${font.reason}：${reason}` : reason;
        }
      }
      return fonts;
    })();
    fontPages.set(page, task);
    return task;
  }
  function fontRuns(index, start = 0, end = index.raw.length) {
    const runs = [];
    for (const part of index.parts || index.pages?.flatMap(page => page.parts) || []) {
      const a = Math.max(start, part.start), b = Math.min(end, part.end);
      if (a >= b || !index.raw.slice(a, b).trim()) continue;
      const style = part.font || { name: '', italic: null, bold: null }, last = runs.at(-1);
      if (last && last.italic === style.italic && last.bold === style.bold && last.name === style.name
        && !index.raw.slice(last.end, a).trim()) last.end = b;
      else runs.push({ ...style, start: a, end: b });
    }
    return runs;
  }
  function fontSummary(runs) {
    const state = key => {
      const values = new Set(runs.map(run => run[key]));
      return !values.size || values.has(null) ? '未知' : values.size > 1 ? '混合' : values.has(true) ? '是' : '否';
    };
    const reasons = [...new Set(runs.map(run => run.reason).filter(Boolean))];
    return `斜体：${state('italic')}；粗体：${state('bold')}` + (reasons.length ? `（${reasons.join('；')}）` : '');
  }
  // HTML tags do not split visible runs. Keep neighboring changes in one word,
  // or separated only by spacing/punctuation, together without crossing a line.
  // Bridge text differences inside one formatting mismatch, never correctly styled text.
  function mergeCandidates(index, items) {
    const merged = [];
    for (const item of items.sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd)) {
      const previous = merged.at(-1), gap = previous && index.raw.slice(previous.sourceEnd, item.sourceStart);
      if (!previous || item.sourceStart < previous.sourceEnd || /[\r\n]/.test(gap)
        || (!item.comparison && gap.trim() && !['italic', 'bold'].some(key =>
          typeof previous.font[key] === 'boolean' && item.font[key] === previous.font[key]
          && index.formats.slice(previous.sourceEnd, item.sourceStart).every((style, i) =>
            /\s/u.test(gap[i]) || (style && style[key] !== previous.font[key]))))
        || (/\s/u.test(gap) && /[\p{L}\p{N}]/u.test(gap))) {
        merged.push(item); continue;
      }
      previous.sourceEnd = item.sourceEnd;
      previous.id = `${item.comparison ? '' : 'font:'}${previous.sourceStart}:${previous.sourceEnd}`;
      if (item.comparison) {
        previous.comparison = { html: index.raw.slice(previous.sourceStart, previous.sourceEnd),
          pdf: previous.comparison.pdf + gap + item.comparison.pdf };
        previous.options[0].edits.push(...item.options[0].edits);
        previous.previewStart = Math.min(previous.previewStart, item.previewStart);
        previous.previewEnd = Math.max(previous.previewEnd, item.previewEnd);
        previous.preview = { html: index.raw.slice(previous.previewStart, previous.previewEnd),
          pdf: index.raw.slice(previous.previewStart, previous.sourceStart) + previous.comparison.pdf
            + index.raw.slice(previous.sourceEnd, previous.previewEnd) };
      } else {
        previous.formats = [...(previous.formats || [{ font: previous.font, htmlFont: previous.htmlFont }]),
          ...(item.formats || [{ font: item.font, htmlFont: item.htmlFont }])];
        previous.text = index.raw.slice(previous.sourceStart, previous.sourceEnd);
      }
    }
    return merged;
  }
  // Compare only unchanged text in confirmed mappings. OCR substitutions have no
  // reliable character correspondence and must not produce formatting guesses.
  function formatDifferences(index, connections) {
    if (!index.formats) return [];
    const items = [], seen = new Set(), runsByTarget = new Map();
    for (const [connection, target] of connections) {
      if (!runsByTarget.has(target)) runsByTarget.set(target, fontRuns(target));
      const runs = runsByTarget.get(target);
      const diff = connection.editorDiff ||= textDiff(index.raw.slice(connection.start, connection.end),
        target.raw.slice(connection.targetStart, connection.targetEnd), true);
      let left = connection.start, right = connection.targetStart;
      for (const part of diff?.parts || []) {
        if (!part.changed) for (const font of runs) {
          const a = Math.max(right, font.start), b = Math.min(right + part.pdf.length, font.end);
          if (a >= b) continue;
          let start = left + a - right;
          const end = left + b - right;
          while (start < end) {
            const htmlFont = index.formats[start];
            let stop = start + 1;
            while (stop < end && index.formats[stop] === htmlFont) stop++;
            if (htmlFont && ['italic', 'bold'].some(key => typeof font[key] === 'boolean' && font[key] !== htmlFont[key])) {
              const text = index.raw.slice(start, stop), a = start + (text.match(/^\s*/)?.[0].length || 0),
                b = stop - (text.match(/\s*$/)?.[0].length || 0), id = `font:${a}:${b}`;
              if (a < b && !seen.has(id)) {
                seen.add(id);
                items.push({ id, sourceStart: a, sourceEnd: b, text: index.raw.slice(a, b), font, htmlFont,
                  options: [{ id: 'inspect', edits: [] }] });
              }
            }
            start = stop;
          }
        }
        left += part.html.length; right += part.pdf.length;
      }
    }
    return mergeCandidates(index, items);
  }
  // One set of character candidates serves file review and selection-triggered review.
  function reviewCandidates(index, targets = [], notice = null) {
    const items = [], seen = new Map();
    const add = (start, parts, pdfRaw = '', pdfStart = 0) => {
      const sourceBase = start, pdfBase = pdfStart;
      const project = (offset, endBias) => {
        let left = sourceBase, right = pdfBase;
        for (const part of parts || []) {
          const stop = right + part.pdf.length;
          if (offset <= stop && part.pdf.length) {
            if (!part.changed) return left + Math.max(0, offset - right);
            if (offset <= right) return left;
            return endBias || offset === stop ? left + part.html.length : left;
          }
          left += part.html.length; right = stop;
        }
        return left;
      };
      for (const part of parts || []) {
        const end = start + part.html.length, id = `${start}:${end}`;
        if (part.changed && significantText(part.html) !== significantText(part.pdf) && ![...seen].some(([a, b]) => start === a || start < b && end > a)) {
          seen.set(start, end);
          const lineStart = pdfRaw.lastIndexOf('\n', Math.max(0, pdfStart - 1)) + 1;
          const nextLine = pdfRaw.indexOf('\n', pdfStart + part.pdf.length);
          const lineEnd = nextLine < 0 ? pdfRaw.length : nextLine;
          let a = pdfRaw ? Math.min(start, project(lineStart, false)) : index.raw.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
          let b = pdfRaw ? Math.max(end, project(lineEnd, true)) : index.raw.indexOf('\n', end);
          if (b < 0) b = index.raw.length;
          a = Math.max(0, a); b = Math.min(index.raw.length, b);
          const html = index.raw.slice(a, b);
          const preview = { html, pdf: index.raw.slice(a, start) + part.pdf + index.raw.slice(end, b) };
          items.push({ id, sourceStart: start, sourceEnd: end, preview, previewStart: a, previewEnd: b,
            comparison: { html: part.html, pdf: part.pdf }, options: [
              { id: 'pdf', label: '替换', edits: textEdits(index, start, end, part.pdf) }
            ] });
        }
        start = end;
        pdfStart += part.pdf.length;
      }
    };
    for (const target of targets.filter(Boolean)) for (const connection of index.connections.get(target) || []) {
      const parts = (connection.editorDiff ||= textDiff(index.raw.slice(connection.start, connection.end),
        target.raw.slice(connection.targetStart, connection.targetEnd), true, Infinity, true))?.parts;
      add(connection.start, parts, target.raw, connection.targetStart);
    }
    if (notice?.source && index.raw.slice(notice.source.start, notice.source.end) === notice.html) {
      add(notice.source.start, textDiff(notice.html, notice.pdf, true, Infinity, true)?.parts);
    }
    return mergeCandidates(index, items);
  }
  function rangeAt(model, start, end) {
    const a = model.getPositionAt(start), b = model.getPositionAt(end);
    return { startLineNumber: a.lineNumber, startColumn: a.column,
      endLineNumber: b.lineNumber, endColumn: b.column };
  }
  // Visible-text offsets are projected through tags/entities onto the original source.
  // Providers that deliberately change markup supply explicit source edits instead.
  function textEdits(index, start, end, replacement) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start
      || end > index.raw.length || typeof replacement !== 'string') throw new Error('无效的可见文字替换范围');
    const segments = [];
    for (let at = start; at < end; at++) {
      const a = index.starts[at], b = index.ends[at], last = segments.at(-1);
      if (index.source.slice(a, b).startsWith('<')) continue;
      if (last && a <= last.end) last.end = Math.max(last.end, b);
      else segments.push({ start: a, end: b });
    }
    if (!segments.length) {
      const at = index.starts[start] ?? index.ends[start - 1] ?? 0;
      segments.push({ start: at, end: at });
    }
    const text = replacement.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return segments.map((segment, i) => ({ ...segment, text: i ? '' : text,
      expected: index.source.slice(segment.start, segment.end) }));
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
    const parts = [];
    let cursor = 0;
    for (const edit of validateEdits(source, edits)) {
      parts.push(source.slice(cursor, edit.start), edit.text); cursor = edit.end;
    }
    parts.push(source.slice(cursor));
    return parts.join('');
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
  function textDiff(left, right, details = false, limit = Infinity, monacoOnly = false) {
    if (left === right) return monacoOnly
      ? (computer ? { parts: left ? [{ html: left, pdf: right, changed: false }] : [] } : null)
      : { distance: 0, parts: details ? (left ? [{ html: left, pdf: right, changed: false }] : []) : undefined };
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
        const append = (html, pdf, changed, refine = true) => {
          if (!html && !pdf) return;
          if (changed && monacoOnly && refine) {
            // Monaco's line/word heuristics can absorb matching text between edits.
            // Refine those runs once; decorations and click mapping share these parts.
            const precise = localTextDiff(html, pdf, true, 128);
            if (precise.distance <= 128) {
              for (const part of precise.parts) append(part.html, part.pdf, part.changed, false);
              return;
            }
          }
          if (!changed && html !== pdf) throw new Error("Incomplete Monaco ranges");
          const last = parts.at(-1);
          if (last?.changed === changed) { last.html += html; last.pdf += pdf; }
          else parts.push({ html, pdf, changed });
        };
        const ranges = [];
        for (const change of result.changes) {
          if (!change.innerChanges?.length) throw new Error("Missing Monaco character ranges");
          for (const { originalRange: x, modifiedRange: y } of change.innerChanges) {
            const startA = offsetA(x.startLineNumber, x.startColumn), endA = offsetA(x.endLineNumber, x.endColumn);
            const startB = offsetB(y.startLineNumber, y.startColumn), endB = offsetB(y.endLineNumber, y.endColumn);
            if (![startA, endA, startB, endB].every(Number.isInteger) || startA < a || startB < b
              || endA < startA || endB < startB || endA > left.length || endB > right.length) throw new Error("Invalid Monaco ranges");
            const previous = ranges.at(-1), gapA = left.slice(a, startA), gapB = right.slice(b, startB);
            // Blank lines can split a moved-looking deletion/insertion of matching text.
            // Refine both sides together so whitespace cannot strand a whole heading.
            if (monacoOnly && previous && gapA === gapB && /^\s*$/.test(gapA)) {
              previous.endA = endA; previous.endB = endB;
            } else ranges.push({ startA, endA, startB, endB });
            a = endA; b = endB;
          }
        }
        a = 0; b = 0;
        for (const { startA, endA, startB, endB } of ranges) {
          append(left.slice(a, startA), right.slice(b, startB), false);
          append(left.slice(startA, endA), right.slice(startB, endB), true);
          a = endA; b = endB;
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
        if (part.changed && significantText(part.html) !== significantText(part.pdf)) {
          const escape = text => JSON.stringify(text).replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, '\\$&');
          const hoverMessage = { value: 'HTML: ' + escape(part.html) + '\n\nOCR: ' + escape(part.pdf), isTrusted: false };
          // Split around markup, retaining complete encoded entities and UTF-16 offsets.
          let at = cursor;
          do {
            const start = index.starts[at] ?? index.ends[at - 1] ?? 0;
            if (at < end && index.source?.[start] === '<') { at++; continue; }
            let stop = start;
            if (at < end) {
              stop = index.ends[at++];
              while (at < end && index.starts[at] <= stop && index.source?.[index.starts[at]] !== '<') stop = index.ends[at++];
            }
            if (index.source?.slice(start, stop).startsWith('<')) continue;
            const key = `${start}:${stop}`;
            if (!seen.has(key)) {
              seen.add(key);
              decorations.push({ range: rangeAt(model, start, stop), options: {
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
    for (const item of formatDifferences(index, connections)) {
      let at = item.sourceStart;
      while (at < item.sourceEnd) {
        const start = index.starts[at];
        if (index.source?.[start] === '<') { at++; continue; }
        let end = index.ends[at++];
        while (at < item.sourceEnd && index.starts[at] <= end) end = index.ends[at++];
        const key = `font:${start}:${end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        decorations.push({ range: rangeAt(model, start, end), options: {
          description: 'PDF font difference', linesDecorationsClassName: 'mew-ocr-diff-line',
          inlineClassName: 'mew-ocr-diff-text mew-font-diff-text', stickiness: 1,
          hoverMessage: { value: `HTML ${fontSummary((item.formats || [item]).map(value => value.htmlFont))}\n\nPDF ${fontSummary((item.formats || [item]).map(value => value.font))}`, isTrusted: false },
          linesDecorationsTooltip: '粗体／斜体与 PDF 不一致'
        } });
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
      connectedRange, indexDocument, indexFonts, getDocumentIndex, findLocations, prepareSource, locateSource, locateLayer };
    // Decode source text without losing offsets into Monaco's original HTML.
    function sourceIndex(source) {
      const template = document.createElement("template"), starts = [], ends = [], formats = [];
      const stack = [{ name: '', italic: false, bold: false }];
      let raw = "", ignored = "";
      const tokens = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);|[^<&]+|[<&]/gi;
      for (const token of source.matchAll(tokens)) {
        const text = token[0], tag = /^<(\/?)\s*([a-z][\w:-]*)/i.exec(text);
        if (ignored) { if (tag?.[1] && tag[2].toLowerCase() === ignored) ignored = ""; continue; }
        let value = text, encoded = false;
        if (tag) {
          const name = tag[2].toLowerCase();
          if (!tag[1] && /^(head|script|style)$/.test(name)) ignored = name;
          if (tag[1]) {
            const at = stack.findLastIndex(value => value.name === name);
            if (at > 0) stack.length = at;
          } else if (!ignored && !/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name) && !/\/\s*>$/.test(text)) {
            const inherited = stack.at(-1), style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(text);
            const declarations = style ? style[1] ?? style[2] : '';
            const italic = /(?:^|;)\s*font-style\s*:\s*([^;!]+)/i.exec(declarations)?.[1].trim();
            const bold = /(?:^|;)\s*font-weight\s*:\s*([^;!]+)/i.exec(declarations)?.[1].trim();
            stack.push({ name, italic: italic && /^(normal|italic|oblique)\b/i.test(italic) ? !/^normal$/i.test(italic) : /^(i|em)$/.test(name) || inherited.italic,
              bold: bold && /^(normal|bold|[1-9]00)$/i.test(bold) ? /bold/i.test(bold) || Number(bold) >= 600 : /^(b|strong|h[1-6])$/.test(name) || inherited.bold });
          }
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
          formats.push(stack.at(-1));
        }
      }
      return { source, raw, starts, ends, formats, normalized: normalized(raw), pageScopes: new WeakMap(), connections: new WeakMap() };
    }
    function editorSourceIndex(model, targets = [], previous = sourceIndexes.get(model)) {
      previous ||= sourceIndexes.get(model);
      const version = model.getVersionId?.();
      if (version !== undefined && previous?.version === version) return previous;
      const source = model.getValue(); if (previous?.source === source && previous.version === version) return previous;
      const index = { source, version, ...sourceIndex(source) };
      if (previous) {
        const { start, oldEnd, newEnd } = changedRange(previous.raw, index.raw);
        // Carry only unchanged passages; offsets within each diff remain relative to its passage.
        const shift = range => range && (range.end <= start ? 0 : range.start >= oldEnd ? newEnd - oldEnd : null);
        targets = [...targets, ...(environment.getTargets?.() || [])];
        const full = getDocumentIndex(environment.getPdf?.());
        if (full) targets.push(full);
        for (const target of new Set(targets.filter(Boolean))) {
          const retained = (previous.connections.get(target) || []).flatMap(item => {
            const delta = shift(item); return delta === null ? [] : [{ ...item, start: item.start + delta, end: item.end + delta }];
          });
          if (retained.length) index.connections.set(target, retained);
          // Full-document preparation starts in the reverse direction too.
          const reverse = (target.connections?.get(previous) || []).flatMap(item => {
            const delta = shift({ start: item.targetStart, end: item.targetEnd });
            return delta === null ? [] : [{ ...item, targetStart: item.targetStart + delta, targetEnd: item.targetEnd + delta }];
          });
          if (reverse.length) target.connections.set(index, reverse);
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
          if (target.difference && entry.index) target.source = { index: entry.index, start: entry.start, end: entry.end };
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
    async function indexFonts(pdf) {
      const index = await indexDocument(pdf);
      if (!index) return null;
      const cached = documents.get(pdf);
      return cached.fontTask ||= (async () => {
        for (const entry of index.pages) {
          await environment.waitForIdle(pdf);
          if (!environment.isCurrent(pdf)) return null;
          const page = await pdf.getPage(entry.number);
          const fonts = await (environment.readPageFonts || readPageFonts)(page, entry.parts.map(part => part.item));
          for (const part of entry.parts) {
            part.font = textItemFont(fonts, part.item);
          }
        }
        return environment.isCurrent(pdf) ? index : null;
      })();
    }
    function prepareSource(source, pages, pdf) {
      if (!source) return;
      pages = [...new Set([...pages, ...(environment.getTargets?.() || [])])];
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
      // An adjacent page can repeat a short quotation from the current page.
      // Its partial match must not compete with a page covering that whole passage.
      const connections = pages.filter(Boolean).flatMap(page =>
        (source.connections.get(page) || []).map(connection => ({ page, connection })));
      for (const page of pages) if (page) source.connections.set(page,
        (source.connections.get(page) || []).filter(item => !connections.some(other => other.page !== page
          && other.connection.start <= item.start && other.connection.end >= item.end
          && other.connection.end - other.connection.start > item.end - item.start)));
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
      const differs = hit && (hit.connection ? hit.approximate
        : significantText(html) !== significantText(entry.text));
      const difference = !hit ? { message: "No reliable HTML match" } : differs ? { html, pdf: entry.text } : null;
      // Exact text selections also need a connection for font-only review.
      // A formatting mismatch has no text difference to create one later.
      if (chunks.length === 1 && hit && !hit.connection)
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
          hit.source = target.source || target.index && { index: target.index, start: target.start, end: target.end };
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
