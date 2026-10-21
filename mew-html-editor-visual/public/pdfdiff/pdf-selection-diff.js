(() => {
  "use strict";
  let computer = null, monacoTask = null;
  const pageTexts = new WeakMap();
  const fontPages = new WeakMap(), pageFontItems = new WeakMap();
  window.PdfSelectionDiff = {
    textDiff, sourceSegments, insertionSegment, layerFonts, fontStyle, fontRuns, fontSummary, formatDifferences, readPageFonts, readPageText, textItemFont,
    textEdits, fontEdits, validateEdits, previewEdits, applyEdits, rangeAt, significantText, changedRange, htmlFontDefinition,
    get monacoAvailable() { return !!computer; },
    useMonaco(value) { computer = value; },
    async loadMonaco() {
      if (computer) return Promise.resolve(true);
      return monacoTask ||= import("/monaco/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js")
        .then(({ DefaultLinesDiffComputer }) => {
          computer = new DefaultLinesDiffComputer();
          return true;
        }).catch(() => false);
    }
  };
  // 粗体／斜体：字体读取、区间归并、摘要、替换编辑与差异比较。
  function fontStyle(font, fallback = '', css = {}) {
    const name = font?.name || fallback;
    // Tesseract placeholder flags do not describe the recognized text.
    if (/glyphlessfont/i.test(name)) return { name, italic: null, bold: null,
      reason: 'GlyphLessFont 占位字体未保留 OCR 粗斜体信息' };
    const italic = /italic|oblique/i.test(css.fontStyle || '')
      || (typeof font?.italic === 'boolean' ? font.italic : /italic|oblique|kursiv/i.test(name) ? true : null);
    const bold = /bold/i.test(css.fontWeight || '') || Number(css.fontWeight) >= 600 || font?.black === true
      || (typeof font?.bold === 'boolean' ? font.bold : /bold|black|heavy|demi|semibold|fett/i.test(name) ? true : null);
    return { name, italic, bold };
  }
  function textItemFont(fonts, item) {
    return fonts?.get(JSON.stringify([item.fontName, item.str, item.transform, item.width])) || fonts?.get(item.fontName);
  }
  async function readPageFonts(page, items) {
    if (fontPages.has(page)) return fontPages.get(page);
    fontPages.set(page, (async () => {
      const ops = window.pdfjsLib?.OPS || { save: 10, restore: 11, setFont: 37, setTextRenderingMode: 38,
        showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47 };
      const invisibleFonts = new Set(), stack = [];
      let fontId = null, mode = 0, failed = false;
      try {
        const list = await page.getOperatorList?.();
        for (let i = 0; i < (list?.fnArray.length || 0); i++) {
          const fn = list.fnArray[i], args = list.argsArray[i];
          if (fn === ops.save) stack.push([fontId, mode]);
          else if (fn === ops.restore && stack.length) [fontId, mode] = stack.pop();
          else if (fn === ops.setFont) fontId = args[0];
          else if (fn === ops.setTextRenderingMode) mode = args[0];
          else if ([ops.showText, ops.showSpacedText, ops.nextLineShowText, ops.nextLineSetSpacingShowText].includes(fn)
            && (mode & 3) === 3) invisibleFonts.add(fontId);
        }
      } catch {
        failed = true; /* Text comparison remains available. */
      }
      const fonts = new Map(), textFonts = new Set();
      let letters = 0, boldLetters = 0;
      for (const item of items) {
        let style = fonts.get(item.fontName);
        if (!style) {
          const id = item.fontName, font = id && page.commonObjs?.has(id) ? page.commonObjs.get(id) : null;
          style = fontStyle(font, id || '');
          if (failed) {
            style.bold = style.italic = null;
            style.reason = '字体读取失败';
          } else if (invisibleFonts.has(id)) {
            // Invisible OCR retains declarations, not scan-derived style evidence.
            style.declaredBold = style.bold;
            style.declaredItalic = style.italic;
            style.reason ||= 'OCR 字体';
          }
          fonts.set(id, style);
        }
        const count = item.str?.replace(/\s/g, '').length || 0;
        if (count) textFonts.add(style);
        letters += count;
        if (style.bold === true) boldLetters += count;
      }
      const dominantBold = letters > 0 && boldLetters / letters >= 0.8;
      for (const key of ['bold', 'italic']) {
        if (!textFonts.size || !(key === 'bold' && dominantBold) && ![...textFonts].every(font => font?.[key] === true)) continue;
        const reason = key === 'bold' && boldLetters < letters ? '大部分文字声明为粗体' : `均为${key === 'bold' ? '粗体' : '斜体'}`;
        for (const font of textFonts) {
          if (font[key] !== true) continue;
          if (key === 'bold') font.declaredBold = true;
          font[key] = null;
          font.reason = font.reason ? `${font.reason}：${reason}` : reason;
        }
      }
      return fonts;
    })());
    return fontPages.get(page);
  }
  function fontRuns(index, start = 0, end = index.raw.length) {
    const runs = [];
    for (const part of index.parts || index.pages?.filter(page => start < page.end && end > page.start).flatMap(page => page.parts) || []) {
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
    const states = [], reasons = [...new Set(runs.map(run => run.reason).filter(Boolean))];
    for (const key of ['italic', 'bold']) {
      const values = new Set(runs.map(run => run[key]));
      const state = !values.size || values.has(null) ? '未知' : values.size > 1 ? '混合' : values.has(true) ? '是' : '否';
      states.push(`${key === 'italic' ? '斜体' : '粗体'}：${state}`);
    }
    return states.join('；') + (reasons.length ? `（${reasons.join('；')}）` : '');
  }
  function fontEdits(index, start, end, font) {
    while (start < end && /\s/u.test(index.raw[start])) start++;
    while (end > start && /\s/u.test(index.raw[end - 1])) end--;
    if (start >= end) return [];
    const keys = ['italic', 'bold'].filter(key => typeof font[key] === 'boolean'
      && index.formats.slice(start, end).some((style, i) => !/\s/u.test(index.raw[start + i]) && style[key] !== font[key]));
    if (!keys.length) return [];
    const tags = [...new Set(index.formats.slice(start, end).flatMap(style => style.tags || []))]
      .filter(tag => keys.some(key => typeof tag[key] === 'boolean'))
      .sort((a, b) => a.openStart - b.openStart);
    if (tags.some(tag => tag.closeStart === undefined || !['i', 'em', 'b', 'strong', 'span'].includes(tag.name))) return [];
    let a = index.starts[start], b = index.ends[end - 1];
    // Include complete wrappers, including whitespace at their edges.
    for (const tag of tags) {
      if (!index.raw.slice(tag.rawStart, start).trim()) a = Math.min(a, tag.openStart);
      if (!index.raw.slice(end, tag.rawEnd).trim()) b = Math.max(b, tag.closeEnd);
    }
    const removed = tags.flatMap(tag => [
      { start: tag.openStart, end: tag.openEnd }, { start: tag.closeStart, end: tag.closeEnd }
    ]).filter(tag => tag.start >= a && tag.end <= b).sort((a, b) => b.start - a.start);
    const strip = (from, to) => {
      let text = index.source.slice(from, to);
      for (const tag of removed) if (tag.start >= from && tag.end <= to)
        text = text.slice(0, tag.start - from) + text.slice(tag.end - from);
      return text;
    };
    // Use source coordinates so whitespace entities also stay outside the tags.
    const leading = strip(a, index.starts[start]), trailing = strip(index.ends[end - 1], b);
    let text = strip(index.starts[start], index.ends[end - 1]);
    for (const key of keys) if (font[key]) {
      const name = key === 'italic' ? 'i' : 'b';
      text = `<${name}>${text}</${name}>`;
    }
    text = leading + text + trailing;
    // Keep the portions of enclosing wrappers outside the selected words.
    const left = tags.filter(tag => tag.openStart < a), right = tags.filter(tag => tag.closeEnd > b);
    const before = index.source.slice(0, a).match(/\s*$/u)[0];
    const after = index.source.slice(b).match(/^\s*/u)[0];
    if (left.length) { a -= before.length; text = left.slice().reverse().map(tag => tag.closing).join('') + before + text; }
    if (right.length) { b += after.length; text += after + right.map(tag => tag.opening).join(''); }
    return [{ start: a, end: b, expected: index.source.slice(a, b), text }];
  }
  // Compare formatting only where unchanged text confirms character correspondence.
  function formatDifferences(index, connections) {
    if (!index.formats) return [];
    const items = new Map();
    for (const [connection, target, diff] of connections) {
      const runs = fontRuns(target, connection.targetStart, connection.targetEnd);
      let left = connection.start, right = connection.targetStart, run = 0;
      for (const part of diff?.parts || []) {
        while (run < runs.length && runs[run].end <= right) run++;
        if (!part.changed) for (let i = run; i < runs.length && runs[i].start < right + part.pdf.length; i++) {
          const font = runs[i];
          const a = Math.max(right, font.start), b = Math.min(right + part.pdf.length, font.end);
          if (a >= b) continue;
          let start = left + a - right;
          const end = left + b - right;
          while (start < end) {
            const htmlFont = index.formats[start];
            let stop = start + 1;
            while (stop < end && index.formats[stop] === htmlFont) stop++;
            const differs = htmlFont && ['italic', 'bold'].some(key => typeof font[key] === 'boolean' && font[key] !== htmlFont[key]);
            if (differs) {
              const text = index.raw.slice(start, stop), a = start + (text.match(/^\s*/)?.[0].length || 0),
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
      const previous = merged.at(-1), gap = previous && index.raw.slice(previous.sourceEnd, item.sourceStart);
      const joins = previous && item.sourceStart >= previous.sourceEnd && !/[\r\n]/.test(gap)
        && previous.htmlFont.tags === item.htmlFont.tags
        && ['italic', 'bold'].every(key => previous.font[key] === item.font[key] && previous.htmlFont[key] === item.htmlFont[key])
        && (!gap.trim() || !(/\s/u.test(gap) && /[\p{L}\p{N}]/u.test(gap)) && ['italic', 'bold'].some(key =>
          typeof previous.font[key] === 'boolean'
          && index.formats.slice(previous.sourceEnd, item.sourceStart).every((style, i) =>
            /\s/u.test(gap[i]) || (style && style[key] !== previous.font[key]))));
      if (!joins) { merged.push(item); continue; }
      previous.sourceEnd = item.sourceEnd;
      previous.formats.push(...item.formats);
    }
    return merged.map(item => ({ ...item, id: `font:${item.sourceStart}:${item.sourceEnd}`,
      text: index.raw.slice(item.sourceStart, item.sourceEnd),
      options: [{ id: 'format', edits: fontEdits(index, item.sourceStart, item.sourceEnd, item.font) }] }));
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
  function layerFonts(view, layer, refresh) {
    const page = view?.pdfPage, objects = page?.commonObjs, fonts = new Map();
    if (page?.getTextContent && !pageFontItems.has(page)) {
      pageFontItems.set(page, { items: [], fonts: new Map() });
      readPageText(page).then(async content => {
        const items = content.items.filter(item => item.str?.length);
        const fonts = await readPageFonts(page, items);
        pageFontItems.set(page, { items, fonts }); refresh();
      }).catch(() => pageFontItems.delete(page));
    }
    const data = pageFontItems.get(page), items = data?.items || [];
    const spans = (view?._textHighlighter?.textDivs || [...layer.querySelectorAll('span[role="presentation"]')]).filter(span => span.textContent);
    const names = new Map();
    if (spans.length === items.length && spans.every((span, i) => span.textContent === items[i].str))
      spans.forEach((span, i) => names.set(span, items[i]));
    return element => {
      const css = element.ownerDocument.defaultView.getComputedStyle(element), family = css.fontFamily;
      const item = names.get(element);
      const observed = item && textItemFont(data?.fonts, item);
      if (observed) return observed;
      const id = item?.fontName || element.dataset?.fontName;
      const key = `${id}:${family}:${css.fontStyle}:${css.fontWeight}`;
      if (!fonts.has(key)) {
        const font = id && objects?.has(id) ? objects.get(id) : objects && [...objects].map(([, value]) => value)
          .find(value => value.loadedName && family.includes(value.loadedName));
        const style = data?.fonts.get(id) || fontStyle(font, family, css);
        fonts.set(key, page?.getTextContent && !data?.fonts.has(id)
          ? { ...style, bold: null, italic: null, reason: '字体渲染模式检查中' } : style);
      }
      return fonts.get(key);
    };
  }
  function readPageText(page) {
    if (!pageTexts.has(page)) pageTexts.set(page, Promise.resolve().then(() => page.getTextContent())
      .catch(error => {
        pageTexts.delete(page);
        throw error;
      }));
    return pageTexts.get(page);
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
  function sourceSegments(index, start, end) {
    const segments = [];
    for (let at = start; at < end; at++) {
      const a = index.starts[at], b = index.ends[at], last = segments.at(-1);
      if (/^\s*$|^</.test(index.source?.slice(a, b))) continue;
      if (last && a <= last.end) last.end = Math.max(last.end, b);
      else segments.push({ start: a, end: b });
    }
    return segments;
  }
  function insertionSegment(index, start) {
    const at = index.starts[start] ?? index.ends[start - 1] ?? 0;
    return { start: at, end: at };
  }
  function textEdits(index, start, end, replacement) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start
      || end > index.raw.length || typeof replacement !== 'string') throw new Error('无效的可见文字替换范围');
    const segments = sourceSegments(index, start, end);
    if (!segments.length) segments.push(insertionSegment(index, start));
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
    if (Number.isFinite(limit) && Math.abs(Array.from(left).length - Array.from(right).length) > limit)
      return { distance: limit + 1, parts: details ? [{ html: left, pdf: right, changed: true }] : undefined };
    // Anchor checks only need a bounded distance, not Monaco's full line alignment.
    if (!details && Number.isFinite(limit)) return localTextDiff(left, right, false, limit);
    if (computer) {
      try { return monacoTextDiff(left, right, details); }
      catch { /* Use the local engine for this comparison; retry Monaco on the next one. */ }
    }
    return localTextDiff(left, right, details, limit);
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
  function monacoTextDiff(left, right, details = false) {
    // Resolve bounded OCR changes before paying for full line alignment.
    if (details) {
      const refined = localTextDiff(left, right, true, 128);
      if (refined.distance <= 128) return refined;
    }
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
  }
  function changedRange(before, after) {
    let start = 0, oldEnd = before.length, newEnd = after.length;
    while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
    return { start, oldEnd, newEnd };
  }
  function appendPart(parts, html, pdf, changed) {
    if (!html && !pdf) return;
    const last = parts.at(-1);
    if (last?.changed === changed) { last.html += html; last.pdf += pdf; }
    else parts.push({ html, pdf, changed });
  }
})();
