// PDF mapping, review candidates, provider actions and highlights.
'use strict';
// Source/PDF mapping and candidate generation.
const pageTexts = new WeakMap();
const fontPages = new WeakMap(), pageFontItems = new WeakMap();
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
class PdfLocator {
  documents = new WeakMap();
  sourceIndexes = new WeakMap();
  reviewAnchors = new WeakMap();
  reviewLists = new WeakMap();
  listeningWindow = null;
  dismissed = null;

  constructor(options = {}, environment = {}) {
    this.options = options;
    this.environment = environment;
    this.pdf = environment.getPdf?.() || {};
    this.document = environment.document || window.document;
  }

  // Only the reader owns decorations, including those in its paired editor.
  bind(target = readerWindow() || window) {
    if (target === this.listeningWindow) return;
    this.listeningWindow?.removeEventListener('pdf-selection-difference', this.prepareReview);
    if (this.listeningWindow === window) {
      window.removeEventListener('pdf-selection-sources', onSources);
      window.removeEventListener('pdf-selection-reset', highlights.clearMarks);
      highlights.clearMarks();
    }
    this.listeningWindow = target;
    target?.addEventListener('pdf-selection-difference', this.prepareReview);
    if (target === window) {
      window.addEventListener('pdf-selection-sources', onSources);
      window.addEventListener('pdf-selection-reset', highlights.clearMarks);
    }
  }

  prepareReview(context = {}) {
    if (context.type === 'replacement-review-closed') {
      const { id, editor, model } = context.detail;
      if (['pdf-ocr', 'pdf-font', 'pdf-bold'].includes(id)) this.dismissed = {
        editor, model, version: model.getVersionId?.(), range: editor.getSelection()?.toString(), interaction: selection()?.interactionId
      };
      return;
    }
    if (context.type === 'pdf-selection-difference') {
      const data = context.detail, editor = data.editor, model = editor?.getModel(), readerHost = this.listeningWindow?.ReplacementReview;
      const destination = data.side === 'pdf' || ['pdf-ocr', 'pdf-font', 'pdf-bold'].some(id => readerHost?.isOpenFor(id, editor)) ? readerHost
        : editor?.getDomNode()?.ownerDocument.defaultView.ReplacementReview || readerHost;
      const dismissed = this.dismissed;
      if (destination !== host || dismissed?.editor === editor && dismissed.model === model && dismissed.version === model?.getVersionId?.()
        && dismissed.range === editor?.getSelection()?.toString() && dismissed.interaction === data.interactionId) return;
      const request = (selection()?.locator || fallbackLocator).prepareReview(data);
      if (!request) return;
      this.dismissed = null;
      if (!request.notice.source || !model) return host.showNotice({
        title: 'PDF 文字差异', message: '文字不一致', comparison: this.comparisonRows(request.notice, false), anchor: data.anchor,
        layout: presentation({ editor, request })
      });
      return host.openForSelection(enabled ? 'pdf-ocr' : activeFontStyles().includes('italic') ? 'pdf-font' : 'pdf-bold', editor, request.focusId, request);
    }
    if (context.notices) {
      if (context.pdf !== viewer()?.pdfDocument || context.model && context.model !== context.editor?.getModel()
        || !enabled && !activeFontStyles().length) return null;
      const changed = context.candidateId && context.kind !== 'font' ? context.notices[0]
        : context.notices.find(value => typeof value.html === 'string' && typeof value.pdf === 'string'
          && (!value.source || value.source.index.raw.slice(value.source.start, value.source.end) === value.html)
          && this.comparisonParts(value).some(part => part.changed));
      const notice = changed || context.notices.find(value => value.source) || context.notices[0];
      if (!notice || changed && !enabled) return null;
      const request = { ...context, notice };
      if (!notice.source || !context.editor?.getModel()) return changed ? request : null;
      const { index, start, end } = notice.source;
      const { items } = this.reviewItems({ editor: context.editor, model: context.model, pdf: context.pdf,
        source: index.source, version: index.version, request });
      const item = items.find(item => context.candidateId ? item.id === context.candidateId
        : changed ? item.selection && item.sourceStart === start && item.sourceEnd === end
          : item.font && item.sourceStart < end && item.sourceEnd > start);
      return item ? { ...request, focusId: item.id, kind: changed ? context.kind : 'font' } : null;
    }
    const pdf = viewer()?.pdfDocument, editor = selection()?.editor, model = editor?.getModel();
    if (!pdf || !model || context.signal?.aborted || context.pdf && context.pdf !== pdf ||
    context.editor && context.editor !== editor || context.model && context.model !== model || (context.version !== undefined ? context.version !== model.getVersionId() : context.source !== undefined && context.source !== model.getValue()))
      return context.source === undefined ? null : { items: [] };
    Object.assign(context, { pdf, editor, model });
    const request = context.request, selected = request?.pdf === pdf && context.source !== undefined && request.notice?.source?.index.source === context.source && request.notice.source.index;
    const index = this.editorSourceIndex(model, selected
      ? [...new Set([request.notice.target?.index, ...(request.targets || [])].filter(Boolean))]
      : model === this.model && pdf === this.pdf ? this.index?.targets : undefined, selected || undefined);
    const { source, target } = request?.notice || {};
    // A selection can confirm an exact text mapping before background preparation.
    if (selected && target && toolbox.normalized(index.raw.slice(source.start, source.end)).text
      === toolbox.normalized(target.index.raw.slice(target.start, target.end)).text)
      index.rememberConnection(source.start, source.end, target.index, { start: target.start, end: target.end });
    if (context.source === undefined) return index;
    if (selected) return this.reviewItems({ request });
    context = { ...context, version: context.version ?? model.getVersionId?.() };
    const pages = (readerWindow() || window).ReaderUI?.getPdfSourcePages?.();
    return (activeFontStyles().length ? this.indexFonts(pdf, index, context.signal, pages) : this.indexDocument(pdf, pages)).then(full => {
      if (!full || context.source !== model.getValue() || !this.prepareReview({ ...context, source: undefined })) return { items: [] };
      this.editorSourceIndex(model, [...new Set([full, ...(this.environment.getTargets?.() || [])])]);
      return this.reviewItems({ request });
    });
  }
  reviewItems(context = {}) {
    if (context.source !== undefined) return this.prepareReview(context);
    this.editorSourceIndex(context.model, context.model && context.model !== this.model ? undefined : this.index?.targets);
    const notice = !context.request?.candidateId && context.request?.notice;
    const shared = this.index.differences, fontStyles = activeFontStyles(), fontKey = fontStyles.join(','), reviewLists = this.reviewLists;
    const cached = reviewLists.get(notice || shared);
    if (cached?.shared === shared && cached.enabled === enabled && cached.fontKey === fontKey && cached.model === this.model) return cached;
    const source = enabled && notice?.source, selected = source && (notice.missing ? [] : this.index.reviewCandidates([], notice));
    const selection = source && (notice.missing || selected.length && !shared.items.some(item => item.missing
      && item.sourceStart < source.end && item.sourceEnd > source.start)) && {
      id: `${source.start}:${source.end}`, sourceStart: source.start, sourceEnd: source.end,
      selection: true, comparison: notice, ...(notice.missing ? { missing: true } : {}),
      options: [{ id: 'pdf', label: '替换', edits: selected.flatMap(item => item.options[0].edits) }]
    };
    const { connections } = shared;
    let items = this.index.formatDifferences(connections, true, fontStyles,
      enabled ? shared.items : shared.items.filter(item => item.font));
    if (selection) {
      const text = items.filter(item => !item.font);
      const selections = [selection], covered = new Set();
      const changes = selection.missing ? [] : this.comparisonParts(notice).filter(part => part.changed);
      const [change] = changes;
      let cursor = 0;
      // Anchor the selected context to confirmed faults in the existing queue.
      for (const anchor of change ? text : []) {
        if (anchor.missing || anchor.comparison.html !== change.html || anchor.comparison.pdf !== change.pdf) continue;
        const start = anchor.sourceStart - change.start, end = start + notice.html.length;
        if (start === selection.sourceStart || start < 0 || this.index.raw.slice(start, end) !== notice.html) continue;
        while (cursor < text.length && text[cursor].sourceEnd < start) cursor++;
        const faults = [];
        for (let at = cursor; at < text.length && text[at].sourceStart <= end; at++) {
          const item = text[at];
          if (item.sourceEnd <= start && item.sourceStart < start || item.sourceStart >= end && item.sourceEnd > end) continue;
          faults.push(item);
        }
        if (faults.length !== changes.length || faults.some((item, at) => item.missing
          || item.sourceStart !== start + changes[at].start || item.sourceEnd !== start + changes[at].end
          || item.comparison.html !== changes[at].html || item.comparison.pdf !== changes[at].pdf)) continue;
        selections.push({ ...selection, id: `${start}:${end}`, sourceStart: start, sourceEnd: end,
          comparison: { html: notice.html, pdf: notice.pdf, source: { index: this.index, start, end } },
          options: [{ id: 'pdf', label: '替换', edits: faults.flatMap(item => item.options[0].edits) }] });
        for (const item of faults) covered.add(item);
      }
      items = [...items.filter(item => item.font || !covered.has(item) && (item.missing && !selection.missing
        || item.sourceEnd <= selection.sourceStart && item.sourceStart < selection.sourceStart
        || item.sourceStart >= selection.sourceEnd && item.sourceEnd > selection.sourceEnd)),
      ...selections];
      const textOrder = items.filter(item => !item.font).sort((a, b) => a.sourceStart - b.sourceStart);
      const positions = new Map();
      cursor = 0;
      for (const item of items) {
        if (!item.font) continue;
        while (cursor < textOrder.length && textOrder[cursor].sourceEnd < item.sourceStart) cursor++;
        const nearby = textOrder[cursor];
        positions.set(item, nearby && nearby.sourceStart <= item.sourceEnd ? nearby.sourceStart : item.sourceStart);
      }
      const order = item => positions.get(item) ?? item.sourceStart;
      items.sort((a, b) => order(a) - order(b) || Number(!!a.font) - Number(!!b.font));
    }
    const data = { index: this.index, model: this.model, shared, enabled, fontKey, connections, items, entries: [], edits: [], plans: [], groups: new Map() };
    for (const value of data.items) {
      if (value.font || value.missing || value.selection) value.range ||= toolbox.rangeAt(this.model, value.sourceStart, value.sourceEnd, this.index);
      value.pdfSource ||= this.sourceEntry(this.index, value.sourceStart, value.sourceEnd, true);
      const key = pattern(value, this.index);
      if (!value.missing) data.plans.push(value.font ? { ...value.options[0],
        title: `替换格式：${value.text}（${fontSummary(value.formats)}）`,
        range: { start: this.index.starts[value.sourceStart], end: this.index.ends[value.sourceEnd - 1] }
      } : value.options[0]);
      let group = data.groups.get(key);
      if (!group) { group = { index: this.index, items: [], entries: [], edits: [] }; data.groups.set(key, group); reviewLists.set(group.items, group); }
      data.groups.set(value, group);
      group.items.push(value); group.entries.push(value.pdfSource); group.edits.push(...value.options[0].edits);
      data.entries.push(value.pdfSource); data.edits.push(...value.options[0].edits);
    }
    reviewLists.set(data.items, data);
    reviewLists.set(notice || shared, data);
    return data;
  }

  comparisonParts(value, parts) {
    const { html, pdf } = value;
    if (value.comparisonDiff?.html !== html || value.comparisonDiff.pdf !== pdf) {
      let offset = 0;
      value.comparisonDiff = { html, pdf, parts: (parts || toolbox.textDiff(html, pdf, true)?.parts || [{ html, pdf, changed: false }]).map(part => ({ ...part,
        start: offset, end: offset += part.html.length, changed: part.changed && toolbox.significantText(part.html) !== toolbox.significantText(part.pdf) })) };
    }
    return value.comparisonDiff.parts;
  }
  comparisonRows(value, compact = true, missing = value?.missing) {
    if (typeof value?.html !== 'string' || typeof value?.pdf !== 'string') return [];
    let parts = this.comparisonParts(value);
    const rows = value.comparisonDiff.rows ||= [], key = Number(compact) + 2 * !!missing;
    if (rows[key]) return rows[key];
    if (compact) {
      const first = parts.findIndex(part => part.changed), last = parts.findLastIndex(part => part.changed);
      if (first >= 0) {
        // Keep every changed run, including unchanged text between distant edits.
        // Reuse the original character diff rather than computing it again on a crop.
        const before = value.html.slice(0, parts[first].start);
        const after = value.html.slice(parts[last].end);
        const prefix = (before.length > 45 ? '…' : '') + before.slice(-45);
        const suffix = after.slice(0, 45) + (after.length > 45 ? '…' : '');
        parts = [...(prefix ? [{ html: prefix, pdf: prefix, changed: false }] : []),
        ...parts.slice(first, last + 1), ...(suffix ? [{ html: suffix, pdf: suffix, changed: false }] : [])];
      }
    }
    return rows[key] = ['html', 'pdf'].map(side => ({
      label: side.toUpperCase(), parts: parts.map(part => {
        const empty = part.changed && !part[side].trim() && !!part[side === 'html' ? 'pdf' : 'html'].trim();
        return { ...part, changed: part.changed && !missing, text: empty ? '' : part[side], source: !compact && value.source
          ? { index: value.source.index, start: value.source.start + part.start, end: value.source.start + part.end } : undefined };
      })
    }));
  }
  sourceEntry(index, start, end, marked, text = index.raw.slice(start, end)) {
    return { index, start, end, marked, text,
      before: index.raw.slice(Math.max(0, start - 160), start), after: index.raw.slice(end, end + 160) };
  }
  sourceIndex(source) {
    const template = this.template ||= this.document.createElement("template");
    const starts = [], ends = [], formats = [];
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
          const definition = toolbox.htmlFontDefinition(name, text, raw.length, token.index);
          stack.push({
            name, definition, italic: definition.italic ?? inherited.italic, bold: definition.bold ?? inherited.bold,
            tags: definition.italic !== null || definition.bold !== null ? [...inherited.tags, definition] : inherited.tags
          });
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
    return new toolbox.PdfSourceIndex(this, { source, raw, starts, ends, formats });
  }
  editorSourceIndex(model = this.model, targets, index) {
    this.model = model;
    this.pdf = this.environment.getPdf?.() || this.pdf;
    let pairs = this.sourceIndexes.get(model);
    if (!pairs) this.sourceIndexes.set(model, pairs = new WeakMap());
    const previous = pairs.get(this.pdf), version = model.getVersionId?.();
    const source = version !== undefined && previous?.version === version ? previous.source : model.getValue();
    if (!index && previous?.source === source && previous.version === version) index = previous;
    if (!index) {
      index = this.sourceIndex(source);
      if (previous) {
        const { start, oldEnd, newEnd } = toolbox.changedRange(previous.raw, index.raw);
        const shift = range => range && (range.end <= start ? 0 : range.start >= oldEnd ? newEnd - oldEnd : null);
        // Keep confirmed, unchanged passages; only edited passages need a new diff.
        for (const target of new Set([...(targets || []), ...(this.environment.getTargets?.() || []), this.getDocumentIndex(this.pdf, this.environment.getSourcePages?.())].filter(Boolean))) {
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
            ...cached, scope: { ...cached.scope, start: cached.scope.start + delta, end: cached.scope.end + delta },
            connections: cached.connections?.map(item => ({ ...item, start: item.start + delta, end: item.end + delta }))
          });
          // Formatting edits retain the same text coordinates in both directions.
          // Reuse the reverse scope too, so the file diff does not rematch the volume.
          if (previous.raw === index.raw) {
            const reverseScope = target.pageScopes?.get(previous);
            if (reverseScope) target.pageScopes.set(index, reverseScope);
          }
        }
      }
    }
    Object.assign(index, { version, model, targets: targets || index.targets || [] });
    pairs.set(this.pdf, index);
    return this.index = index;
  }
  reviewAnchor(item, currentIndex = this.index) {
    const source = item?.pdfSource;
    if (!source) return null;
    let anchors = this.reviewAnchors.get(item);
    if (!anchors) this.reviewAnchors.set(item, anchors = new WeakMap());
    // Read the candidate's confirmed diff, including after its HTML offsets move.
    // Popup layout must never search again or prepare another source mapping.
    for (const { index } of this.environment.getVisiblePages?.() || []) {
      if (!index?.layer?.isConnected) continue;
      const connections = source.index.connections.get(index), currentConnections = currentIndex?.connections.get(index);
      let cached = anchors.get(index);
      if (!cached || cached.connections !== connections || cached.currentIndex !== currentIndex || cached.currentConnections !== currentConnections) {
        const hit = source.index.connectedRange(index, source.start, source.end, false, undefined, true)
          || currentIndex && currentIndex !== source.index && currentIndex.connectedRange(index, item.sourceStart, item.sourceEnd, false, undefined, true)
          || item.missing && source.index.missingRange(index, source.start, source.end);
        cached = { connections, currentIndex, currentConnections, hit };
        anchors.set(index, cached);
      }
      const hit = cached.hit;
      if (!hit) continue;
      const layer = index.layer.getBoundingClientRect();
      if (cached.bounds) return {
        left: layer.left + cached.bounds.left * layer.width,
        top: layer.top + cached.bounds.top * layer.height, bottom: layer.top + cached.bounds.bottom * layer.height
      };
      const end = index.raw.slice(hit.start, hit.end).trim() ? hit.end : hit.start;
      const bounds = { left: Infinity, top: Infinity, bottom: -Infinity };
      const range = this.document.createRange();
      for (const part of index.fontRuns(hit.start, end, true)) {
        range.setStart(part.node, Math.max(0, Math.min(part.node.length, hit.start - part.start)));
        range.setEnd(part.node, Math.max(0, Math.min(part.node.length, end - part.start)));
        for (const box of range.getClientRects()) if (box.height && (box.width || end === hit.start)) {
          bounds.left = Math.min(bounds.left, box.left);
          bounds.top = Math.min(bounds.top, box.top);
          bounds.bottom = Math.max(bounds.bottom, box.bottom);
        }
      }
      if (bounds.bottom !== -Infinity) {
        if (layer.width && layer.height) cached.bounds = {
          left: (bounds.left - layer.left) / layer.width,
          top: (bounds.top - layer.top) / layer.height, bottom: (bounds.bottom - layer.top) / layer.height
        };
        return bounds;
      }
    }
    return null;
  }
  readPageText(page) {
    if (!pageTexts.has(page)) pageTexts.set(page, Promise.resolve().then(() => page.getTextContent())
      .catch(error => {
        pageTexts.delete(page);
        throw error;
      }));
    return pageTexts.get(page);
  }
  async readPageFonts(page, items) {
    if (fontPages.has(page)) return fontPages.get(page);
    fontPages.set(page, (async () => {
      const ops = window.pdfjsLib?.OPS || { save: 10, restore: 11, setFont: 37, setTextRenderingMode: 38,
        showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47 };
      const textOps = new Set([ops.showText, ops.showSpacedText, ops.nextLineShowText, ops.nextLineSetSpacingShowText]);
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
          else if (textOps.has(fn)
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
  layerFonts(view, layer, refresh) {
    const page = view?.pdfPage, objects = page?.commonObjs, fonts = new Map();
    if (page?.getTextContent && !pageFontItems.has(page)) {
      pageFontItems.set(page, { items: [], fonts: new Map() });
      this.readPageText(page).then(async content => {
        const items = content.items.filter(item => item.str?.length);
        const fonts = await this.readPageFonts(page, items);
        pageFontItems.set(page, { items, fonts }); refresh();
      }).catch(() => pageFontItems.delete(page));
    }
    const data = pageFontItems.get(page), items = data?.items || [];
    const spans = (view?._textHighlighter?.textDivs || [...layer.querySelectorAll('span[role="presentation"]')]).filter(span => span.textContent);
    const names = new Map();
    if (spans.length === items.length && spans.every((span, i) => span.textContent === items[i].str))
      spans.forEach((span, i) => names.set(span, items[i]));
    return Object.assign(element => {
      const item = names.get(element);
      const observed = item && textItemFont(data?.fonts, item);
      if (observed) return observed;
      const css = element.ownerDocument.defaultView.getComputedStyle(element), family = css.fontFamily;
      const id = item?.fontName || element.dataset?.fontName;
      const key = `${id}:${family}:${css.fontStyle}:${css.fontWeight}`;
      if (!fonts.has(key)) {
        const font = id && objects?.has(id) ? objects.get(id) : objects && [...objects]
          .find(([, value]) => value.loadedName && family.includes(value.loadedName))?.[1];
        const style = data?.fonts.get(id) || fontStyle(font, family, css);
        fonts.set(key, page?.getTextContent && !data?.fonts.has(id)
          ? { ...style, bold: null, italic: null, reason: '字体渲染模式检查中' } : style);
      }
      return fonts.get(key);
    }, { items: names });
  }
  async indexDocument(pdf, numbers) {
    let documents = this.documents.get(pdf);
    if (!documents) this.documents.set(pdf, documents = new Map());
    const key = numbers ? `pages:${numbers.join(',')}` : '';
    if (documents.has(key)) return documents.get(key).task;
    const cached = {};
    documents.set(key, cached);
    cached.task = (async () => {
      let raw = "", mappedStart = 0;
      const pages = [], mapped = { text: "", starts: [], ends: [] };
      for (const number of numbers || Array.from({ length: pdf.numPages }, (_, i) => i + 1)) {
        if (!this.environment.isCurrent(pdf)) return null;
        await this.environment.waitForIdle(pdf);
        if (!this.environment.isCurrent(pdf)) return null;
        const page = await pdf.getPage(number), content = await this.readPageText(page);
        if (!this.environment.isCurrent(pdf)) return null;
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
          toolbox.normalized(raw.slice(mappedStart), mapped, mappedStart); mappedStart = raw.length;
        }
      }
      toolbox.normalized(raw.slice(mappedStart), mapped, mappedStart);
      cached.index = new toolbox.PdfSourceIndex(this, { raw, pages, normalized: mapped, sourcePages: numbers });
      if (this.environment.isCurrent(pdf)) this.environment.onIndexed?.();
      return cached.index;
    })().catch(error => {
      documents.delete(key);
      throw error;
    });
    const index = await cached.task;
    if (!index) documents.delete(key);
    return index;
  }
  getDocumentIndex(pdf, numbers) { return this.documents.get(pdf)?.get(numbers ? `pages:${numbers.join(',')}` : '')?.index; }
  async indexFonts(pdf, source, signal, numbers) {
    const index = await this.indexDocument(pdf, numbers);
    if (!index || signal?.aborted) return null;
    const ranges = source?.differences.connections.flatMap(([connection, target]) => target === index ? [connection] : []);
    for (const entry of index.pages) {
      if (source && !ranges?.some(hit => hit.targetStart < entry.end && hit.targetEnd > entry.start)
        || entry.parts.every(part => part.font)) continue;
      if (signal?.aborted || !this.environment.isCurrent(pdf)) return null;
      // Share in-flight work too; separate reviews can request the same page.
      await (entry.fontTask ||= (async () => {
        await this.environment.waitForIdle(pdf);
        if (!this.environment.isCurrent(pdf)) return;
        const page = await pdf.getPage(entry.number);
        if (!this.environment.isCurrent(pdf)) return;
        const fonts = await this.readPageFonts(page, entry.parts.map(part => part.item));
        if (!this.environment.isCurrent(pdf)) return;
        for (const part of entry.parts) part.font = textItemFont(fonts, part.item);
        index.fontVersion = (index.fontVersion || 0) + 1;
      })().finally(() => { entry.fontTask = null; }));
    }
    return !signal?.aborted && this.environment.isCurrent(pdf) ? index : null;
  }
}
// Shared popup and session initialization.

// PDF comparison is one review provider. Selection synchronization remains independent.
let host, toolbox, fallbackLocator, highlights;
let enabled = true, fontStyles = ['italic', 'bold'];
function readerWindow() {
  if (window.ReaderUI?.getPdfViewer) return window;
  try { if (window.opener && !window.opener.closed && window.opener.ReaderUI?.getPdfViewer) return window.opener; } catch { }
  return null;
}
function viewer() { return readerWindow()?.ReaderUI.getPdfViewer() || window.PdfSelection?.viewer; }
function selection() { return readerWindow()?.PdfSelection || window.PdfSelection; }
function activeFontStyles() {
  const reader = readerWindow();
  return reader && reader !== window ? reader.PdfReviewProvider?.fontStyles || fontStyles : fontStyles;
}
function presentation(context, item) {
  const reader = readerWindow() || window, source = context.editor?.getDomNode()?.ownerDocument.defaultView || window;
  const split = source !== reader, side = split ? context.request?.side || 'html' : 'pdf';
  const request = context.request;
  const element = request?.anchorElement, box = request?.anchorBox;
  const rect = element?.isConnected && element.getBoundingClientRect();
  const requested = (!item || item.sourceStart === request?.notice?.source?.start) && (rect && box ? {
    left: rect.left + box.x * rect.width, top: rect.top + box.y * rect.height,
    bottom: rect.top + (box.y + box.h) * rect.height
  } : request?.anchor);
  const anchor = item?.missing && requested
    || item && side === 'pdf' && (selection()?.locator || fallbackLocator).reviewAnchor(item) || requested;
  const destination = side === 'pdf' ? reader : source;
  return {
    side, switchable: split, switchLabel: side === 'pdf' ? '查看HTML' : '查看PDF', host: destination.ReplacementReview, window: destination,
    container: viewer()?.container, eventBus: viewer()?.eventBus, anchor,
    highlights: side === 'pdf' ? [anchor,
      ...(context.highlightedItems || []).flatMap(value => value === item ? [] : [(selection()?.locator || fallbackLocator).reviewAnchor(value)])
    ].filter(Boolean) : []
  };
}
function content(state, item) {
  const edits = item?.options[0].edits || [], formats = item?.formats || [item], data = (selection()?.locator || fallbackLocator).reviewLists.get(state.items);
  const message = item?.missing ? 'PDF OCR 缺少相关文字。' : item?.font ? fontSummary(formats)
    : item ? '文字不一致' : state.items.length ? '已到末尾，可返回上一条。' : '没有可审阅的差异。';
  return {
    message, edits: data?.groups.get(item)?.edits, allEdits: data?.edits,
    comparison: item?.font ? [] : (selection()?.locator || fallbackLocator).comparisonRows(item?.preview || item?.comparison, !item?.selection, item?.missing),
    previewDecorations: item?.font || item?.missing ? item.previewDecorations ||= (selection()?.locator || fallbackLocator).index.sourceSegments(item.sourceStart, item.sourceEnd, true).map(segment => ({
      range: toolbox.rangeAt(state.model, segment.start, segment.end), options: { inlineClassName: item.missing ? 'mew-review-proposed' : 'mew-review-format', stickiness: 1 }
    })) : [],
    apply: !!edits.length,
    range: item?.range || (edits.length ? toolbox.rangeAt(state.model, Math.min(...edits.map(edit => edit.start)), Math.max(...edits.map(edit => edit.end))) : null),
    options: [], applyLabel: item?.font ? '替换格式' : '替换', advance: false, expanded: false
  };
}
function pattern(value, index) {
  if (value.missing || !index) return value;
  const { raw } = index, start = value.sourceStart, end = value.sourceEnd;
  // Unknown or foreign source context may only match the candidate itself.
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > raw.length
    || value.pdfSource && value.pdfSource.index !== index) return value;
  if (value.selection) return JSON.stringify(['selection', value.comparison.html, value.comparison.pdf]);
  let before = start, after = end;
  const word = /^[\p{L}\p{M}\p{N}_'’\-]+$/u;
  while (before > 0 && word.test(raw.slice(before - (raw.codePointAt(before - 2) > 0xffff ? 2 : 1), before)))
    before -= raw.codePointAt(before - 2) > 0xffff ? 2 : 1;
  while (after < raw.length && word.test(String.fromCodePoint(raw.codePointAt(after))))
    after += raw.codePointAt(after) > 0xffff ? 2 : 1;
  if (!value.font && value.options?.[0]) value.options[0].range = {
    start: index.starts[before] ?? index.source.length,
    end: after > before ? index.ends[after - 1] : index.starts[before] ?? index.source.length };
  const prefix = raw.slice(before, start), suffix = raw.slice(end, after);
  if ([...raw.slice(before, after)].length < 2
    && [...(prefix + (value.comparison?.pdf ?? value.text ?? '') + suffix)].length < 2) return value;
  const change = value.font ? [value.text, ...['italic', 'bold'].flatMap(key => [value.htmlFont[key], value.font[key]])]
      : [value.comparison?.html, value.comparison?.pdf];
  return JSON.stringify([!!value.font, change, prefix, suffix]);
}
function matchingItems(item, context, items) {
  if (!item) return [];
  const { index, reviewLists } = (selection()?.locator || fallbackLocator), data = reviewLists.get(items);
  if (data && data.index === index) return (data.groups?.get(item) || data.groups?.get(pattern(item, index)))?.items || [];
  const key = pattern(item, index);
  return items.filter(value => pattern(value, index) === key);
}
function apply(state, all) {
  const { index } = (selection()?.locator || fallbackLocator), item = state.items[state.position];
  const selected = all ? state.items : matchingItems(item, state.context, state.items), candidates = new Set(selected);
  if (all || item.font) for (const candidate of state.items)
    if (candidate.font && selected.some(value => value.font && candidate.sourceStart < value.sourceEnd && candidate.sourceEnd > value.sourceStart))
      candidates.add(candidate);
  const checked = toolbox.validateEdits(state.source, [...candidates].flatMap(value => value.options[0].edits));
  const offset = index.starts[item.sourceStart] ?? state.source.length;
  const shifted = offset + checked.reduce((delta, edit) => delta + (edit.end <= offset
    ? edit.text.length - (edit.end - edit.start) : 0), 0);
  toolbox.applyEdits(state.editor, state.model, state.version, state.source, checked);
  return { offset: shifted };
}

const review = {
  compact: true, content, apply, presentation, matchingItems,
  isCurrent: ({ source, ...context }) => (source === undefined || source === context.model.getValue()) && !!(selection()?.locator || fallbackLocator).prepareReview(context),
  available: editor => !!(selection()?.locator || fallbackLocator).prepareReview({ editor }),
  selectComparison(context, part) {
    const { index, start, end } = part.source, owner = index.locator.document.defaultView;
    context.editor.setSelection(toolbox.rangeAt(context.model, start, end, index));
    owner.dispatchEvent(new owner.CustomEvent('pdf-selection-difference', { detail: { ...context, ...context.request, interactionId: undefined, snapshot: null, notices: [part] } }));
  },
  onSelect(item, context, items, previewEnabled = false) {
    context.editor.getDomNode()?.classList.toggle('mew-review-preview', previewEnabled);
    context.highlightedItems = matchingItems(item, context, items);
    selection()?.showReviewPointer(context.editor, context.highlightedItems);
  },
  onClose(context) {
    delete context.highlightedItems;
    context.editor.getDomNode()?.classList.remove('mew-review-preview');
    selection()?.clearReviewPointer(context.editor);
  }
};
function onSources(event) {
  const fontStyles = activeFontStyles();
  const { editor, index, targets, enabled: highlighted } = event.detail;
  if (!editor?.createDecorationsCollection || !(selection()?.locator || fallbackLocator).prepareReview({ editor })) return;
  if (index) index.targets = targets;
  const model = editor.getModel(), data = index && index.locator.reviewItems({ model });
  host.bindSuggestions(editor, currentModel => editor === selection()?.editor && (selection()?.locator || fallbackLocator).prepareReview({ editor, model: currentModel })
    ? (selection()?.locator || fallbackLocator).reviewItems({ model: currentModel }).plans : []);
  if (editor.addAction && !editor.getAction('mew.pdf-difference')) {
    const action = editor.addAction({
      id: 'mew.pdf-difference', label: '查看 PDF 差异',
      run(_, request) {
        const model = editor.getModel(), reader = readerWindow() || window;
        if (!(selection()?.locator || fallbackLocator).prepareReview({ editor, model, version: request.version }) || model.uri.toString() !== request.model) return;
        const index = (selection()?.locator || fallbackLocator).editorSourceIndex(model), item = index.locator.reviewItems().items.find(item => item.id === request.id);
        if (!item) return;
        const notice = { ...item.comparison, source: { index, start: item.sourceStart, end: item.sourceEnd } };
        reader.dispatchEvent(new reader.CustomEvent('pdf-selection-difference', { detail: {
          editor, model, pdf: viewer()?.pdfDocument, notices: [notice], targets: index.targets,
          candidateId: item.id, kind: item.font ? 'font' : 'text', side: 'pdf'
        } }));
        const owner = editor.getDomNode()?.ownerDocument.defaultView;
        if (owner && owner !== reader) {
          reader.name ||= `mew-review-${crypto.randomUUID()}`;
          owner.open('', reader.name)?.focus();
        }
      }
    });
    editor.onDidDispose(() => action.dispose());
  }
  const command = editor.getId?.() && `${editor.getId()}:mew.pdf-difference`;
  highlights.updateSource(editor, [index, highlighted, data, model],
    () => highlighted && index ? index.sourceDecorations(data.connections, model, fontStyles, enabled, targets, data.items,
      item => sourceHover(item, model, command)) : []);
  if (event.detail.diffEnabled && data) selection()?.showReviewPointer(editor, data.items, data);
}
function sourceHover(item, model, command) {
  const escape = text => JSON.stringify(text.trim() ? text : '').replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, '\\$&');
  const request = { model: model.uri?.toString(), version: model.getVersionId?.(), id: item.id };
  const pdf = command ? `[PDF:](command:${command}?${encodeURIComponent(JSON.stringify([request]))})` : 'PDF:';
  const htmlText = item.font ? fontSummary(item.formats, 'htmlFont') : escape(item.comparison.html);
  const pdfText = item.font ? fontSummary(item.formats, 'font') : escape(item.comparison.pdf);
  return { value: item.missing ? `${pdf} PDF OCR 缺少相关文字。` : `HTML: ${htmlText}\n\n${pdf} ${pdfText}`,
    isTrusted: command ? { enabledCommands: [command] } : false };
}
function fontSummary(runs, field) {
  const states = [['italic', '斜体', new Set()], ['bold', '粗体', new Set()]], reasons = new Set();
  for (const value of runs) for (const [key, label, values] of states) {
    const run = value[field || 'font'];
    if (field) { values.add(run[key]); if (run.reason) reasons.add(run.reason); }
    else if (typeof run[key] === 'boolean' && run[key] !== value.htmlFont[key])
      values.add(`${label}不一致（HTML ${value.htmlFont[key] ? '是' : '否'} / PDF ${run[key] ? '是' : '否'}${key === 'bold' && run.scanBoldRatio ? '，扫描估计' : ''}）`);
  }
  return states.map(([, label, values]) => field ? `${label}：${!values.size || values.has(null) ? '未知' : values.size > 1 ? '混合' : values.has(true) ? '是' : '否'}` : [...values].join('；')).filter(Boolean).join('；')
    + (reasons.size ? `（${[...reasons].join('；')}）` : '');
}
window.PdfReviewReady = (async () => {
  if (!window.PdfSelectionDiff) await import('./pdf-selection-diff.js');
  await window.PdfSelectionDiff.ready;
  toolbox = window.PdfSelectionDiff;
  if (!window.ReplacementReview || !window.ReviewHighlights) await import('./replacement-review.js');
  host = window.ReplacementReview;
  try { enabled = localStorage.getItem('mew.pdf-review.enabled') !== 'false'; } catch { }
  fallbackLocator = new PdfLocator({}, {
    document, getPdf: () => viewer()?.pdfDocument,
    isCurrent: pdf => viewer()?.pdfDocument === pdf,
    waitForIdle: () => new Promise(resolve => setTimeout(resolve, 0))
  });
  highlights = window.ReviewHighlights.create({
    document,
    classes: { selection: 'mew-pdf-selection-highlight', pointer: 'mew-pdf-review-pointer', caret: 'mew-pdf-selection-caret' }
  });
  const unregister = [host.register({
    ...review, get locator() { return (selection()?.locator || fallbackLocator); },
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
      try { localStorage.setItem('mew.pdf-review.enabled', String(value)); } catch { }
      for (const id of ['pdf-font', 'pdf-bold']) host.invalidate(id);
      selection()?.refresh();
    }
  }), ...['italic', 'bold'].map(key => host.register({
    ...review, get locator() { return (selection()?.locator || fallbackLocator); },
    id: key === 'italic' ? 'pdf-font' : 'pdf-bold', label: key === 'italic' ? 'PDF 斜体探测' : 'PDF 粗体探测',
    isEnabled: () => activeFontStyles().includes(key),
    setEnabled(value) {
      (readerWindow()?.PdfReviewProvider || window.PdfReviewProvider).setFontEnabled(value, key);
    },
    focusIndex(items, request) {
      const start = request?.notice?.source?.start;
      return start === undefined ? -1 : items.findIndex(item => item.sourceEnd > start);
    },
    containsSelection(item, request) {
      const source = request?.notice?.source;
      return source && item.sourceStart < source.end && item.sourceEnd > source.start;
    }
  })), ...[
    ['pdf-selection', 'PDF 差异高亮', 'enabled', value => selection()?.setDiffHighlight(value), true],
    ['source-diff', '源码差异高亮', 'sourceEnabled', value => selection()?.setDiffHighlight(value, 'source'), true],
    ['pdf-selection-sync', 'PDF 与源码选区联动', 'selectionEnabled', value => selection()?.setSelectionHighlight(value)]
  ].map(([id, label, setting, setEnabled, toggleOnly]) => host.register({
    id, label, toggleOnly, setEnabled, available: () => !!selection(), isEnabled: () => selection()?.[setting] === true
  }))];
  window.PdfReviewProvider = {
    PdfLocator, PdfSourceIndex: toolbox.PdfSourceIndex, fontStyle, textItemFont, sourceHover,
    get fontEnabled() { return activeFontStyles().length > 0; },
    get fontStyles() { return activeFontStyles(); },
    get textEnabled() { return enabled; },
    setFontEnabled(value, key, persist = true) {
      fontStyles = ['italic', 'bold'].filter(name => !key || name === key ? value : fontStyles.includes(name));
      if (persist) for (const style of key ? [key] : ['italic', 'bold'])
        selection()?.savePreference(`${style}Detection`, !!value, '无法保存字体探测设置');
      for (const id of ['pdf-ocr', 'pdf-font', 'pdf-bold']) host.invalidate(id);
      selection()?.clearReviewPointer();
      selection()?.refresh();
    },
    measureHighlights: highlights.measureHighlights, paintHighlight: highlights.paintHighlight, clearHighlights: highlights.clearHighlights,
    getHighlight: highlights.getHighlight,
    selectionRange: highlights.selectionRange
  };
  window.addEventListener('replacement-review-closed', fallbackLocator.prepareReview = fallbackLocator.prepareReview.bind(fallbackLocator));
  fallbackLocator.bind();
  let previousPdf = viewer()?.pdfDocument, previousApi = selection(), previousEnabled, previousFonts = activeFontStyles();
  const poll = setInterval(() => {
    fallbackLocator.bind();
    const pdf = viewer()?.pdfDocument, api = selection(), fonts = activeFontStyles(), state = `${api?.enabled}:${api?.sourceEnabled}:${api?.selectionEnabled}:${fonts}`;
    if (previousPdf !== pdf || previousFonts !== fonts) {
      const fontsChanged = previousFonts !== fonts;
      previousPdf = pdf; previousFonts = fonts;
      for (const id of ['pdf-ocr', 'pdf-font', 'pdf-bold']) host.invalidate(id, context => fontsChanged || context.pdf !== pdf);
    }
    if (previousApi !== api || previousEnabled !== state) {
      previousApi = api; previousEnabled = state; host.refreshMenu();
    }
  }, 500);
  window.addEventListener('pagehide', () => { clearInterval(poll); fallbackLocator.bind(null); highlights.dispose(); window.removeEventListener('replacement-review-closed', fallbackLocator.prepareReview); unregister.forEach(dispose => dispose()); });
  return window.PdfReviewProvider;
})();
