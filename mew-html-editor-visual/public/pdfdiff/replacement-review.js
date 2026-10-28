// Reusable text-range overlays and Monaco decoration lifecycle. No PDF or review dependencies.
(() => {
  'use strict';
  window.ReviewHighlights = { create };
  function create({ document = window.document, classes = {} }) {
    const { selection: selectionClass = 'review-highlight', pointer: pointerClass = 'review-pointer',
      caret: caretClass = 'review-caret' } = classes;
    const selectionAreas = new Map(), pointerAreas = new Map(), marks = new Map();
    return { measureHighlights, paintHighlight, clearHighlights, clearMarks, updateSource, selectionRange,
      getHighlight: (div, pointer = false) => (pointer ? pointerAreas : selectionAreas).get(div),
      dispose() { clearHighlights(); clearHighlights(true); clearMarks(); } };
    function measureHighlights(div, index, hits, focusHit) {
      // Measure the indexed text nodes in their reading order.
      const boxes = [], notices = [];
      let range;
      const union = (a, b) => {
        const left = Math.min(a.left, b.left), top = Math.min(a.top, b.top), right = Math.max(a.right, b.right);
        return { left, top, right, width: right - left, height: Math.max(a.top + a.height, b.top + b.height) - top };
      };
      let focus = null;
      for (const hit of hits) {
        let noticeBox = null;
        const caret = hit.start === hit.end || !!hit.difference && !index.raw.slice(hit.start, hit.end).trim();
        const at = caret && hit.endBias ? Math.max(0, hit.start - 1) : hit.start;
        // Reading order can differ from DOM order; measure the indexed text nodes.
        for (const part of index.partsInRange(at, caret ? at : hit.end)) {
          range ||= (div.ownerDocument || document).createRange();
          range.setStart(part.node, Math.max(0, hit.start - part.start));
          range.setEnd(part.node, Math.max(0, Math.min(part.node.length, (caret ? hit.start : hit.end) - part.start)));
          if (!caret && !range.toString().trim()) continue;
          for (let box of caret ? [range.getBoundingClientRect()] : range.getClientRects()) if ((box.width || caret) && box.height) {
            // Collapsed ranges can have a fractional width in Chromium. Always
            // draw missing text as a visible caret at the insertion point.
            if (caret) box = { left: box.left - 2, right: box.left + 2, top: box.top, width: 4, height: box.height, caret: true };
            const previous = boxes.at(-1);
            // Range rects can include both a span and its text, or adjoining spans.
            if (previous && !previous.caret && !box.caret && Math.abs(previous.top - box.top) < .5 && Math.abs(previous.height - box.height) < .5
              && box.left >= previous.left && box.left <= previous.right + .5) {
              boxes[boxes.length - 1] = union(previous, box);
            } else boxes.push(box);
            noticeBox = noticeBox ? union(noticeBox, box) : box;
            if (hit === focusHit && !focus) focus = box;
          }
        }
        if (noticeBox) notices.push({ box: noticeBox, ...hit.difference, target: { index, start: hit.start, end: hit.end }, source: hit.source });
      }
      const pageBox = div.getBoundingClientRect();
      const sx = pageBox.width / div.offsetWidth, sy = pageBox.height / div.offsetHeight;
      const relative = box => ({
        x: (box.left - pageBox.left - div.clientLeft * sx) / (div.clientWidth * sx),
        y: (box.top - pageBox.top - div.clientTop * sy) / (div.clientHeight * sy),
        w: box.width / (div.clientWidth * sx), h: box.height / (div.clientHeight * sy), caret: !!box.caret
      });
      return { count: hits.length, focus: focus && relative(focus), boxes: boxes.map(relative), notices: notices.map(notice => ({ ...notice, box: relative(notice.box) })) };
    }
    function paintHighlight(div, boxes, color, pointer = false) {
      const store = pointer ? pointerAreas : selectionAreas;
      const previous = store.get(div);
      if (previous?.boxes === boxes && previous.node.isConnected) return previous;
      if (!boxes.length) {
        previous?.node.remove();
        store.delete(div);
        return;
      }
      const overlay = previous?.node.isConnected ? previous.node : document.createElement("div");
      if (!overlay.isConnected) {
        overlay.className = selectionClass + (pointer ? ' ' + pointerClass : '');
        overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:20;overflow:hidden;contain:strict;";
        div.append(overlay);
      }
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        let mark = overlay.children[i];
        if (!mark) {
          mark = document.createElement("div");
          mark.setAttribute("aria-hidden", "true");
          overlay.append(mark);
        }
        mark.style.cssText = `position:absolute;left:${box.x * 100}%;top:${box.y * 100}%;width:${box.w * 100}%;height:${box.h * 100}%;border-radius:2px;pointer-events:none;`;
        mark.style.background = color;
        mark.classList.toggle(caretClass, box.caret);
      }
      while (overlay.children.length > boxes.length) overlay.lastElementChild.remove();
      const painted = { node: overlay, boxes };
      store.set(div, painted);
      return painted;
    }
    function clearHighlights(pointer = false, visible = new Set()) {
      const areas = pointer ? pointerAreas : selectionAreas;
      for (const [div, painted] of areas) if (!visible.has(div)) {
        painted.node.remove(); areas.delete(div);
      }
    }
    function clearMarks() {
      for (const state of marks.values()) { state.collection.clear(); state.dispose?.(); state.style?.remove(); }
      marks.clear();
    }
    function updateSource(editor, key, decorations, css) {
      let state = marks.get(editor);
      if (!state) {
        const doc = editor.getDomNode()?.ownerDocument || document, style = css ? doc.createElement('style') : null;
        if (style) { style.textContent = css; doc.head.append(style); }
        state = { collection: editor.createDecorationsCollection(), style };
        const subscription = editor.onDidChangeModel?.(() => { state.key = null; state.collection.clear(); });
        state.dispose = () => subscription?.dispose();
        marks.set(editor, state);
      }
      if (state.key?.length === key.length && key.every((value, i) => value === state.key[i])) return;
      const values = decorations();
      for (const { options } of values) if (options.linesDecorationsClassName === 'mew-ocr-diff-line') {
        delete options.linesDecorationsClassName; delete options.linesDecorationsTooltip;
      }
      state.collection.set(values);
      editor.render?.(true);
      state.key = key;
    }
    function selectionRange(editor, event, range) {
      if (event?.source === 'replacement-review-close') return null;
      // A text drag owns its full range, even when it ends on a diff marker.
      if (!event?.lineRange && !range.isEmpty?.()) return null;
      const collection = marks.get(editor)?.collection, position = event?.position || range.getStartPosition();
      for (let i = 0; i < (collection?.length || 0); i++) {
        const mark = collection.getRange(i);
        if (event?.lineRange ? mark?.intersectRanges(event.lineRange) : mark?.containsPosition(position)
          && (mark.isEmpty() || position.lineNumber !== mark.endLineNumber || position.column !== mark.endColumn)) return mark;
        // Missing text beside a space must also be reachable from that space.
        if (!event?.lineRange && mark?.isEmpty() && position.lineNumber === mark.startLineNumber
          && position.column + 1 === mark.startColumn && /^\s$/u.test(editor.getModel().getValueInRange({
            startLineNumber: position.lineNumber, startColumn: position.column,
            endLineNumber: mark.startLineNumber, endColumn: mark.startColumn }))) return mark;
      }
      return null;
    }
  }
})();

// Shared review popup, session, navigation and saving. Providers own content and actions.
(() => {
  'use strict';
  const providers = new Map();
  const previewKey = 'mew-review-preview';
  let session = null, generation = 0, pending = null, view = null, previewModels = [], disposals = [], lastRequest = null;
  let widget = null, widgetEditor = null, noticeAnchor = null, noticeLayout = null, manualTimer = null, composing = false;
  let placementFrame = null, returningToWindow = !document.hasFocus();
  const revisionMarks = window.ReviewHighlights.create({ document });
  const menu = document.getElementById('replacementFeatures');
  const panel = document.createElement('section');
  panel.className = 'replacement-review'; panel.hidden = true;
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '审阅与批量替换');
  panel.innerHTML = `<div class="review-heading"><strong data-title></strong><span data-position></span><button type="button" data-switch hidden></button><button type="button" data-close aria-label="关闭审阅">×</button></div>
    <p data-status role="status"></p><div data-comparison></div><div data-options class="review-options"></div>
    <div class="review-controls"><button type="button" data-prev aria-label="上一条" title="上一条">↑</button><button type="button" data-next aria-label="下一条" title="下一条">↓</button><button type="button" data-apply aria-pressed="false" title="开启或关闭修改预览，不更改正文">预览</button><button type="button" data-advance>应用并下一条</button><button type="button" data-save>替换&amp;保存</button></div>
    <details data-expanded><summary>差异预览与批量操作</summary><div class="review-controls"><label><input type="checkbox" data-file>整个文件 diff</label><button type="button" data-all>应用全部候选的所选方案</button></div><div data-preview data-review-preview></div></details>`;
  document.body.append(panel);
  const fields = Object.create(null);
  const get = name => fields[name] ||= panel.querySelector(`[data-${name}]`);
  function workspace() {
    const owner = session?.editor.getDomNode()?.ownerDocument.defaultView;
    return owner?.mewWorkbench || owner?.readerMonaco;
  }
  function message(text) { get('status').textContent = text; get('status').hidden = !text; }
  function current() { return session?.items[session.position]; }
  function selectedEdits(all = false) {
    return (all ? session.items : session.provider.matchingItems?.(current(), session.context, session.items) || [current()])
      .flatMap(item => item?.options.find(value => value.id === session.choices.get(item.id))?.edits || []);
  }
  function presentation() { return session?.provider.presentation?.(session.context, current()) || noticeLayout; }
  function opposite(state) {
    const layout = state.provider.presentation?.(state.context, state.items[state.position]);
    if (!layout?.switchable) return null;
    const request = { ...state.context.request, side: layout.side === 'pdf' ? 'html' : 'pdf' };
    const peer = state.provider.presentation({ ...state.context, request }, state.items[state.position]);
    return peer?.host && peer.host !== window.ReplacementReview ? { ...peer, request } : null;
  }
  function valid() {
    return session && !session.stale && session.editor.getModel() === session.model
      && (session.version !== undefined ? session.model.getVersionId?.() === session.version : session.model.getValue() === session.source)
      && (!session.provider.isCurrent || session.provider.isCurrent(session.context));
  }
  function validateCandidates(result) {
    const ids = new Set();
    return (result.items || result).map(item => {
      if (typeof item.id !== 'string' || ids.has(item.id) || !item.options?.length) throw new Error('候选必须有唯一 id 和修改选项');
      ids.add(item.id);
      const options = new Set();
      for (const value of item.options) {
        if (typeof value.id !== 'string' || options.has(value.id)) throw new Error('修改选项必须有唯一 id');
        options.add(value.id);
      }
      return item;
    });
  }
  function updateMenu() {
    if (!menu) return;
    menu.replaceChildren();
    if (!providers.size) { const hint = document.createElement('span'); hint.textContent = '暂无可用的审阅功能'; menu.append(hint); }
    for (const provider of providers.values()) {
      const row = document.createElement('div'); row.className = 'review-feature';
      if (provider.setEnabled) {
        const label = document.createElement('label'), input = document.createElement('input');
        input.type = 'checkbox'; input.checked = provider.isEnabled?.() !== false;
        input.disabled = provider.available?.() === false;
        input.setAttribute('aria-label', `启用${provider.label}`);
        input.onchange = () => {
          provider.setEnabled(input.checked);
          if (!input.checked && (session?.provider === provider || lastRequest?.id === provider.id)) close();
          updateMenu();
        };
        label.append(input);
        if (provider.toggleOnly) label.append(document.createTextNode(provider.label));
        row.append(label);
      }
      if (provider.toggleOnly) { menu.append(row); continue; }
      const button = document.createElement(provider.provide ? 'button' : 'span'); button.textContent = provider.label;
      if (provider.provide) { button.type = 'button'; button.onclick = () => { const overflow = menu.closest('details'); if (overflow) overflow.open = false; void open(provider.id); }; }
      row.append(button); menu.append(row);
    }
  }
  function clearPreview() {
    view?.setModel(null);
    const previous = previewModels.splice(0);
    // Monaco releases the previous diff view model on the next event-loop turn.
    if (previous.length) setTimeout(() => previous.forEach(model => model.dispose()), 0);
  }
  function mount(target) {
    const api = target?.getDomNode()?.ownerDocument.defaultView.monaco;
    if (!target?.addContentWidget || !api) return;
    widgetEditor = target;
    widget = {
      getId: () => 'mew.replacement-review', getDomNode: () => panel,
      allowEditorOverflow: false, suppressMouseDown: false,
      getPosition() {
        if (panel.hidden) return null;
        const range = session?.anchor;
        const position = range ? { lineNumber: range.startLineNumber, column: range.startColumn } : target.getPosition();
        return { position, preference: [api.editor.ContentWidgetPositionPreference.ABOVE, api.editor.ContentWidgetPositionPreference.BELOW] };
      }
    };
    panel.dataset.contentWidget = '';
    panel.style.top = ''; panel.style.left = '';
    target.addContentWidget(widget);
  }
  function close(dismiss = true, restoreFocus = true, position = null) {
    cancelAnimationFrame(placementFrame); placementFrame = null;
    clearTimeout(manualTimer); manualTimer = null; composing = false;
    ++generation; pending?.abort(); pending = null;
    disposals.splice(0).forEach(dispose => dispose());
    revisionMarks.clearMarks();
    clearPreview(); panel.hidden = true; lastRequest = null; noticeAnchor = noticeLayout = null;
    if (widget) { widgetEditor.removeContentWidget(widget); widget = widgetEditor = null; document.body.append(panel); delete panel.dataset.contentWidget; panel.style.cssText = ''; }
    const previous = session; session = null;
    previous?.provider.onClose?.(previous.context);
    if (dismiss && previous && previous.editor.getModel() === previous.model) {
      const selected = previous.editor.getSelection();
      if (selected && (position || restoreFocus && !selected.isEmpty())) previous.editor.setPosition(position || selected.getPosition(), 'replacement-review-close');
    }
    if (dismiss && previous) opposite(previous)?.host.close(false, false);
    const detail = dismiss && previous && { id: previous.provider.id, editor: previous.editor, model: previous.model };
    if (detail) window.dispatchEvent(new CustomEvent('replacement-review-closed', { detail }));
    const owner = previous?.editor.getDomNode()?.ownerDocument.defaultView;
    if (detail && owner && owner !== window) owner.dispatchEvent(new owner.CustomEvent('replacement-review-closed', { detail }));
    if (dismiss && restoreFocus && panel.dataset.side !== 'pdf') previous?.editor.focus();
  }
  function stale(event) {
    if (!session) return;
    session.stale = true; ++generation; clearPreview(); revisionMarks.clearMarks();
    const saved = session;
    if (!saved.manualPending) saved.resumeOffset = saved.anchorOffset ?? 0;
    // Monaco change offsets refer to the source before this event.
    const offset = saved.resumeOffset;
    saved.resumeOffset = offset + (event?.changes || []).reduce((delta, change) => delta + (
      change.rangeOffset >= offset ? 0 : change.rangeOffset + change.rangeLength <= offset
        ? change.text.length - change.rangeLength : change.rangeOffset - offset
    ), 0);
    saved.manualPending = true;
    if (event) { saved.needsSave = true; saved.manualSave = true; }
    clearTimeout(manualTimer);
    message('正在自动重新计算差异…' + (saved.needsSave ? ' 内容已修改，请保存。' : '')); controls();
    if (!composing) manualTimer = setTimeout(() => void refreshAfterEdit(saved), 350);
  }
  function refreshAfterEdit(saved) {
    if (saved.refreshTask) return saved.refreshTask;
    if (session !== saved || !saved.manualPending || composing || saved.editor.getModel() !== saved.model) return Promise.resolve();
    const request = ++generation, source = saved.model.getValue(), version = saved.model.getVersionId?.();
    const context = { ...saved.context, source, version, request: { ...saved.context.request, snapshot: null } };
    return saved.refreshTask = (async () => {
    try {
      const sameReference = !saved.provider.isCurrent || saved.provider.isCurrent(context);
      if (!sameReference) { context.targets = null; context.request = { side: context.request?.side }; }
      const result = sameReference && saved.provider.refreshAfterEdit
        ? await saved.provider.refreshAfterEdit(context, saved.resumeOffset, saved)
        : { items: await saved.provider.provide(context), position: saved.position };
      if (session !== saved || request !== generation || saved.model.getValue() !== source
        || saved.model.getVersionId?.() !== version || (saved.provider.isCurrent && !saved.provider.isCurrent(context))) return;
      const items = validateCandidates(result);
      Object.assign(saved, { items, position: result.position ?? saved.position,
        context, source, version, stale: false, manualPending: false });
      saved.choices = result.choices || new Map(saved.items.map(item => [item.id, saved.choices.get(item.id) || item.options[0].id]));
      render(true);
    } catch (error) { if (session === saved && request === generation) message(error.message); }
    })().finally(() => {
      saved.refreshTask = null;
      if (session === saved && saved.manualPending && !composing && request !== generation)
        manualTimer = setTimeout(() => void refreshAfterEdit(saved), 0);
    });
  }
  function controls() {
    const item = current(), currentVersion = valid(), busy = !!(session?.applying || session?.saving);
    const ready = (currentVersion || session?.manualPending && !composing) && !!item && !busy && !session.waitingApply;
    const canApply = ready && session.provider.apply && session.content?.apply !== false;
    get('apply').disabled = !currentVersion || !item || busy;
    for (const name of ['advance', 'all']) get(name).disabled = !canApply;
    get('save').textContent = session?.manualSave ? '保存修改' : '替换&保存';
    get('save').disabled = !workspace()?.save || busy || !(session?.manualSave ? session.editor.getModel() === session.model : canApply);
    const blocked = !currentVersion || !!session?.applying;
    get('prev').disabled = blocked || session.position <= 0;
    get('next').disabled = blocked || session.position >= session.items.length - 1;
    get('position').textContent = session ? `${Math.min(session.position + 1, session.items.length)} / ${session.items.length}` : '';
  }
  function subscribe(target, event, callback) {
    const listener = target[event]?.(callback);
    if (listener) disposals.push(() => listener.dispose());
  }
  async function open(id, suppliedEditor, focusId, fallbackPosition = 0, requestData = null) {
    const provider = providers.get(id), target = suppliedEditor || window.mewWorkbench?.editor || window.readerMonaco?.editor;
    const placement = provider?.presentation?.({ editor: target, request: requestData });
    if (placement?.host && placement.host !== window.ReplacementReview) return placement.host.open(id, target, focusId, fallbackPosition, requestData);
    close(false);
    lastRequest = { id, editor: target, focusId };
    panel.hidden = false;
    panel.classList.toggle('compact', !!provider?.compact);
    panel.dataset.side = placement?.side || 'html';
    get('expanded').hidden = !!provider?.compact;
    if (provider?.compact) get('expanded').open = false;
    get('prev').parentElement.hidden = false;
    get('advance').hidden = false;
    get('switch').hidden = !placement?.switchable;
    get('switch').textContent = placement?.switchLabel || '';
    get('title').textContent = provider?.label || '审阅'; get('options').replaceChildren(); get('comparison').replaceChildren(); controls();
    if (!provider || !target?.getModel()) { message('请先打开可编辑的文件。'); place(); return; }
    if (provider.isEnabled?.() === false) { message('请先在菜单中启用此功能。'); place(); return; }
    if (placement?.side !== 'pdf') {
      target.getDomNode()?.ownerDocument.defaultView.readerMonaco?.showSource?.();
      mount(target);
    }
    const request = ++generation, controller = pending = new AbortController();
    const model = target.getModel(), source = model.getValue(), version = model.getVersionId?.();
    const context = { ...requestData?.snapshot?.context, editor: target, model, source, version, signal: controller.signal, toolbox: window.PdfSelectionDiff, request: requestData };
    subscribe(target, 'onDidChangeModel', () => close());
    subscribe(target, 'onDidChangeModelContent', event => {
      if (event.isFlush || !session) close();
      else if (!session.applying) stale(event);
    });
    const ownerWindow = target.getDomNode()?.ownerDocument.defaultView;
    const dirtyIndicator = ownerWindow?.document.getElementById(ownerWindow.mewWorkbench ? 'tabs' : 'saveBtn');
    const dirtyObserver = new MutationObserver(() => {
      if (!session?.needsSave || target.getModel() !== session.model) return;
      const dirty = ownerWindow.mewWorkbench
        ? [...ownerWindow.mewWorkbench.documents.values()].find(doc => doc.model === session.model)?.dirty
        : dirtyIndicator.classList.contains('dirty');
      if (dirty !== false) return;
      session.needsSave = false; session.manualSave = false;
      if (valid()) render(true);
      else { message('已保存。差异更新中…'); controls(); }
    });
    if (dirtyIndicator) dirtyObserver.observe(dirtyIndicator, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    disposals.push(() => dirtyObserver.disconnect());
    subscribe(target, 'onDidCompositionStart', () => { composing = true; clearTimeout(manualTimer); });
    subscribe(target, 'onDidCompositionEnd', () => {
      composing = false;
      if (session?.manualPending) { const saved = session; manualTimer = setTimeout(() => void refreshAfterEdit(saved), 0); }
    });
    // Keep an opening session so typing while extraction runs schedules a fresh calculation.
    session = { provider, editor: target, model, source, version, context, items: [], position: 0,
      choices: new Map(),
      manualSave: requestData?.snapshot?.manualSave || false, needsSave: requestData?.snapshot?.needsSave || false };
    subscribe(target, 'onDidScrollChange', queuePlace);
    if (placement?.container) {
      const container = placement.container;
      container.addEventListener('scroll', queuePlace); disposals.push(() => container.removeEventListener('scroll', queuePlace));
      placement.eventBus?.on('textlayerrendered', queuePlace);
      disposals.push(() => placement.eventBus?.off('textlayerrendered', queuePlace));
    }
    message('正在计算候选…'); place(target);
    try {
      const snapshot = requestData?.snapshot;
      const result = snapshot?.model === model && snapshot.source === source && snapshot.version === version
        ? snapshot.items : await provider.provide(context);
      if (request !== generation || providers.get(id) !== provider) return;
      if (target.getModel() !== model || model.getValue() !== source || model.getVersionId?.() !== version
        || (provider.isCurrent && !provider.isCurrent(context))) { stale(); return; }
      const items = validateCandidates(result);
      let found = items.findIndex(item => item.id === focusId);
      if (found < 0) found = provider.focusIndex?.(items, requestData) ?? -1;
      Object.assign(session, { items,
        position: found >= 0 ? found : Math.max(0, Math.min(fallbackPosition, items.length - 1)),
        manualSave: snapshot?.manualSave || false, needsSave: snapshot?.needsSave || false, choices: new Map(items.map(item => [item.id, snapshot?.choices.get(item.id) || item.options[0].id])) });
      render(!!requestData, !!requestData?.mirror);
    } catch (error) { if (request === generation) {
      if (provider.isCurrent && !provider.isCurrent(context)) stale();
      else { message(error.message); controls(); }
    } }
    finally { if (pending === controller) pending = null; }
  }
  function render(preserveSelection = false, mirrored = false) {
    if (!session) return;
    const item = current();
    session.content = session.provider.content?.(session, item) || {};
    const content = session.content;
    let previewEnabled = false;
    try { previewEnabled = localStorage.getItem(previewKey) === 'true'; } catch {}
    get('apply').setAttribute('aria-pressed', String(previewEnabled));
    get('options').replaceChildren(); controls();
    message((content.message || '') + (session.needsSave ? ' 内容已修改，请保存。' : '')); comparison(content.comparison);
    get('title').textContent = content.title || session.provider.label;
    for (const name of ['advance', 'expanded', 'all']) get(name).hidden = content[name] === false;
    if (item) {
      for (const value of content.options || []) {
        const label = document.createElement('label'), input = document.createElement('input');
        input.type = 'radio'; input.name = 'review-choice'; input.checked = session.choices.get(item.id) === value.id;
        input.onchange = () => { session.choices.set(item.id, value.id); render(); };
        label.append(input, document.createTextNode(value.label)); get('options').append(label);
      }
      selectField(preserveSelection); session.provider.onSelect?.(item, session.context, session.items, previewEnabled);
    } else session.provider.onClose?.(session.context);
    if (session.editor.getDomNode()?.ownerDocument === document) {
      revisionMarks.updateSource(session.editor, [session.model, session.version ?? session.source, item, session.choices.get(item?.id), previewEnabled],
        () => [...(previewEnabled ? selectedEdits() : []).flatMap(edit => {
          if (edit.options) return [edit];
          let offset = edit.start;
          return session.context.toolbox.textDiff(session.source.slice(edit.start, edit.end), edit.text, true).parts.flatMap(part => {
            const start = offset;
            offset += part.html.length;
            return part.changed ? [{ start, end: offset, text: part.pdf }] : [];
          });
        }).map(edit => ({
          range: session.context.toolbox.rangeAt(session.model, edit.start, edit.end),
          options: edit.options || { description: 'Revision preview', stickiness: 1, showIfCollapsed: true,
            inlineClassName: edit.end > edit.start ? 'mew-review-current' : undefined,
            beforeContentClassName: edit.start === edit.end && edit.text ? 'mew-review-insert' : undefined,
            after: edit.text ? { content: edit.text, inlineClassName: 'mew-review-proposed', cursorStops: 0 } : undefined }
        })), ...(previewEnabled ? content.previewDecorations || [] : [])]);
    }
    void preview(); place(session.editor);
    const peer = !mirrored && opposite(session);
    if (peer) peer.host.mirror(session, { ...peer.request, mirror: true, snapshot: { ...session } });
  }
  function comparison(rows = []) {
    get('comparison').replaceChildren();
    for (const row of rows) {
      const line = document.createElement('div');
      if (row.label) line.append(`${row.label}: `);
      for (const part of row.parts || []) {
        const span = document.createElement(part.changed ? 'mark' : 'span'); span.textContent = part.text; line.append(span);
        if (part.changed && current()?.selection) { span.style.cursor = 'pointer'; span.onclick = () => { if (!valid()) return;
          const parts = current().comparison.comparisonDiff.parts, at = row.parts.indexOf(part), start = current().sourceStart + parts.slice(0, at).reduce((offset, value) => offset + value.html.length, 0), owner = session.context.index.locator.document.defaultView;
          session.editor.setSelection(session.context.index.sourceRange(session.model, start, start + parts[at].html.length)); owner.dispatchEvent(new owner.CustomEvent('pdf-selection-difference', { detail: { ...session.context, ...session.context.request, interactionId: undefined, snapshot: null, notices: [{ ...parts[at], source: { index: session.context.index, start, end: start + parts[at].html.length } }] } })); }; }
      }
      get('comparison').append(line);
    }
  }
  function showNotice({ title = '', message: text, comparison: rows, anchor, layout }) {
    if (layout?.host && layout.host !== window.ReplacementReview) return layout.host.showNotice({ title, message: text, comparison: rows, anchor, layout });
    close(); panel.hidden = false; noticeAnchor = anchor; noticeLayout = layout;
    panel.classList.add('compact'); panel.dataset.side = layout?.side || 'html';
    get('title').textContent = title; get('options').replaceChildren();
    for (const name of ['switch', 'advance', 'expanded']) get(name).hidden = true;
    comparison(rows); message(text || ''); controls(); get('prev').parentElement.hidden = true; place();
  }
  function openForSelection(id, target, focusId, request) {
    if (session?.applying || session?.saving) return;
    if (session?.manualPending && session.provider.id === id && session.editor === target) return;
    if (session?.provider.id === id && session.editor === target && valid()) {
      const sameInteraction = request?.interactionId !== undefined && request.interactionId === session.context.request?.interactionId;
      // Selection synchronization after our own navigation is not a new review request.
      if (sameInteraction && target.getSelection()?.equalsRange(session.anchor)) { place(target); return; }
      const previousSource = session.context.request?.notice?.source, source = request?.notice?.source;
      const sameSelection = source && previousSource && source.index === previousSource.index
        && source.start === previousSource.start && source.end === previousSource.end;
      session.context.request = { ...session.context.request, ...request, side: session.context.request?.side };
      if (sameInteraction && (sameSelection || session.provider.containsSelection?.(current(), request))) { place(target); return; }
      const at = session.items.findIndex(item => item.id === focusId);
      if (at >= 0) { if (at !== session.position) { session.position = at; render(true); } else place(target); return; }
      // A broader selected passage can contain the current character candidate.
      if (session.provider.containsSelection?.(current(), request)) { place(target); return; }
    }
    if (pending && lastRequest?.id === id && lastRequest.editor === target && lastRequest.focusId === focusId) return;
    return open(id, target, focusId, 0, request);
  }
  function selectField(preserveSelection) {
    const range = preserveSelection && session.editor.getSelection() || session.content?.range;
    session.anchor = session.content?.range ? session.model.validateRange(session.content.range) : range;
    if (range) {
      session.anchorOffset = session.model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
      if (!preserveSelection) {
        session.editor.setSelection(session.model.validateRange(range));
      }
      session.editor.revealRangeInCenterIfOutsideViewport(session.anchor);
    }
  }
  async function preview() {
    if (get('expanded').hidden || !get('expanded').open || !valid() || !current()) return;
    const saved = session, request = ++generation;
    try {
      const api = await window.MewEditorCore.loadMonaco();
      if (session !== saved || request !== generation || !valid() || !get('expanded').open) return;
      const data = session.provider.preview ? await session.provider.preview(session, get('file').checked)
        : { before: session.source, after: window.PdfSelectionDiff.previewEdits(session.source, selectedEdits(get('file').checked)), language: session.model.getLanguageId() };
      if (!data || session !== saved || request !== generation || !valid()) return;
      const { before, after, language = 'plaintext' } = data;
      if (!view) view = api.editor.createDiffEditor(get('preview'), { automaticLayout: true, readOnly: true, originalEditable: false,
        renderSideBySide: false, minimap: { enabled: false }, scrollBeyondLastLine: false, diffAlgorithm: 'advanced' });
      clearPreview();
      previewModels = [api.editor.createModel(before, language), api.editor.createModel(after, language)];
      view.setModel({ original: previewModels[0], modified: previewModels[1] });
    } catch (error) { if (session === saved && request === generation) { clearPreview(); message(error.message); } }
  }
  async function apply(all) {
    const saved = session;
    if (saved?.waitingApply) return;
    if (saved?.refreshTask || saved?.manualPending && !composing)
      await (saved.waitingApply = saved.refreshTask || refreshAfterEdit(saved)).finally(() => { saved.waitingApply = null; });
    if (session !== saved || !valid()) return;
    if (!current() || !saved.provider.apply || saved.applying) return;
    saved.applying = true; controls();
    try {
      // Providers receive candidate data; session lifecycle remains owned here.
      const result = await saved.provider.apply({ editor: saved.editor, model: saved.model,
        source: saved.source, version: saved.version, items: saved.items,
        position: saved.position, choices: saved.choices, context: { ...saved.context } }, all);
      if (session !== saved) return;
      const source = saved.model.getValue(), changed = source !== saved.source;
      Object.assign(saved, { items: result.items, choices: result.choices || saved.choices,
        position: result.position, context: result.context || saved.context,
        source, version: saved.model.getVersionId?.() });
      if (changed) saved.needsSave = true;
      Object.assign(saved.context, { source: saved.source, version: saved.version });
      if (saved.context.request) saved.context.request = { ...saved.context.request, snapshot: null };
      if (!valid()) { stale(); return; }
      render();
      return true;
    } catch (error) {
      if (session !== saved) return;
      if (saved.model.getValue() !== saved.source) stale();
      message(error.message);
    } finally { saved.applying = false; controls(); }
  }
  function navigate(direction) {
    if (!valid() || session.applying) return;
    const next = session.position + direction;
    if (next >= 0 && next < session.items.length) { session.position = next; render(); }
  }
  function queuePlace() {
    if (!panel.hidden && placementFrame === null) placementFrame = requestAnimationFrame(() => {
      placementFrame = null; place();
    });
  }
  function place(target = session?.editor) {
    if (panel.hidden) return;
    const layout = presentation(), pdfSide = layout?.side === 'pdf', compact = panel.classList.contains('compact');
    const node = pdfSide ? layout.container : target?.getDomNode(), rect = node?.getBoundingClientRect();
    if (layout) {
      panel.dataset.side = layout.side;
      get('switch').hidden = !layout.switchable;
      get('switch').textContent = layout.switchLabel || '';
    }
    const left = Math.max(8, rect?.left || 8), right = Math.min(innerWidth - 8, rect?.right || innerWidth - 8);
    panel.style.width = compact ? 'max-content' : `${Math.max(0, Math.min(460, right - left))}px`;
    panel.style.maxWidth = `${Math.max(0, Math.min(compact ? 280 : 460, right - left))}px`;
    panel.style.maxHeight = `${Math.max(100, Math.min(innerHeight - 16, (rect?.height || innerHeight) * (compact ? .45 : .7)))}px`;
    if (widget) { widgetEditor.layoutContentWidget(widget); return; }
    const range = session?.anchor;
    const position = !pdfSide && range ? target.getScrolledVisiblePosition({ lineNumber: range.startLineNumber, column: range.startColumn }) : null;
    const top = Math.max(8, rect?.top || 8), bottom = Math.min(innerHeight - 8, rect?.bottom || innerHeight - 8);
    const fragment = layout?.anchor || noticeAnchor;
    const anchor = Math.max(top, Math.min(bottom, fragment?.top ?? (rect?.top || 0) + (position?.top ?? 40)));
    const height = panel.getBoundingClientRect().height;
    const end = fragment?.bottom ?? anchor + (position?.height || 20);
    const roomAbove = Math.max(0, anchor - top - 8), roomBelow = Math.max(0, bottom - end - 8);
    const useAbove = roomAbove >= height || roomAbove >= roomBelow;
    const available = Math.min(height, useAbove ? roomAbove : roomBelow);
    // Only the current anchor positions the popup when preview paints matching diffs.
    panel.style.visibility = !available ? 'hidden' : '';
    panel.style.maxHeight = `${available}px`;
    panel.style.top = `${useAbove ? anchor - available - 8 : end + 8}px`;
    panel.style.left = `${Math.max(left, Math.min(right - panel.offsetWidth, fragment?.left ?? left + (position?.left || 0)))}px`;
  }
  get('close').onclick = close;
  get('switch').onclick = () => {
    if (!valid()) return;
    const peer = opposite(session)?.window;
    if (!peer || peer.closed) return;
    peer.name ||= `mew-review-${crypto.randomUUID()}`;
    window.open('', peer.name)?.focus();
    peer.document.querySelector('.replacement-review [data-switch]')?.focus({ preventScroll: true });
  };
  document.getElementById('reviewBtn')?.addEventListener('click', () => void open('pdf-ocr', window.PdfSelection?.editor));
  get('prev').onclick = () => void navigate(-1);
  get('next').onclick = () => void navigate(1);
  get('apply').onclick = () => {
    if (!valid() || get('apply').disabled) return;
    try { localStorage.setItem(previewKey, String(get('apply').getAttribute('aria-pressed') !== 'true')); } catch { return; }
    render(true);
    if (get('apply').getAttribute('aria-pressed') === 'true' && session.content.range) session.editor.revealRangeInCenterIfOutsideViewport(session.content.range);
  };
  get('advance').onclick = () => void apply(false);
  get('all').onclick = () => apply(true);
  async function save() {
    const saved = session, owner = workspace();
    if (!saved || !owner?.save || get('save').disabled) return;
    saved.saving = true; controls();
    try {
      if (!saved.manualSave && !await apply(false)) return;
      // A popup refresh must not cancel saving an already applied replacement.
      if (saved.editor.getModel() !== saved.model) throw new Error('文件已切换，未保存替换。');
      saved.manualSave = true;
      const source = saved.model.getValue();
      const result = await owner.save({ followPdf: false });
      if (result === false) throw new Error('保存失败，修改仍未保存，请重试。');
      if (session === saved && saved.model.getValue() === source) {
        saved.needsSave = false; saved.manualSave = false;
        if (valid()) render();
        else message('已保存。差异更新中…');
      }
    }
    catch (error) { if (session === saved) message(error.message); }
    finally { saved.saving = false; controls(); }
  }
  get('save').onclick = () => save();
  get('file').onchange = () => void preview();
  get('expanded').ontoggle = () => { void preview(); place(); };
  panel.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') close(); });
  window.addEventListener('blur', () => { if (!document.hasFocus()) returningToWindow = true; });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing && !panel.hidden) {
      event.preventDefault(); event.stopPropagation();
      close(true, panel.contains(document.activeElement));
      return;
    }
    if (document.hasFocus() && !['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)
      && !(event.key === 'Tab' && event.altKey)) returningToWindow = false;
  }, true);
  document.addEventListener('pointerdown', event => {
    // The click that returns to this window must not dismiss its review popup.
    const returning = returningToWindow || !document.hasFocus();
    returningToWindow = false;
    if (panel.hidden || returning || event.composedPath().includes(panel)) return;
    const position = session?.editor.getTargetAtClientPoint(event.clientX, event.clientY)?.position;
    const api = session?.editor.getDomNode()?.ownerDocument.defaultView.monaco;
    if (position && session.anchor && api?.Range.containsPosition(session.anchor, position)) return;
    close(true, false, event.button === 0 && event.composedPath().includes(session?.editor.getDomNode()) ? position : null);
  }, true);
  new ResizeObserver(queuePlace).observe(panel);
  window.addEventListener('resize', queuePlace);
  window.addEventListener('storage', event => {
    if ((event.key === previewKey || event.key === null) && valid()) render(true, true);
  });
  window.addEventListener('pagehide', () => { close(); view?.dispose(); });
  window.ReplacementReview = {
    open, openForSelection, showNotice, close, refreshMenu: updateMenu,
    mirror(saved, request) {
      if (session?.provider.id === saved.provider.id && session.editor === saved.editor && session.model === saved.model) {
        ++generation; clearTimeout(manualTimer);
        Object.assign(session, { source: saved.source, version: saved.version, items: saved.items, position: saved.position,
          choices: new Map(saved.choices), needsSave: saved.needsSave, manualSave: saved.manualSave,
          context: { ...saved.context, request }, stale: false, manualPending: false });
        render(true, true);
      } else void open(saved.provider.id, saved.editor, saved.items[saved.position]?.id, saved.position, request);
    },
    isOpenFor(id, target) { return !panel.hidden && (session?.provider.id === id && session.editor === target || lastRequest?.id === id && lastRequest.editor === target); },
    invalidate(id, changed = () => true) { if (session?.provider.id === id && changed(session.context)) stale(); },
    register(provider) {
      if (!provider?.id || (typeof provider.provide !== 'function' && typeof provider.setEnabled !== 'function')) throw new Error('功能需要 id 和 provide(context) 或 setEnabled(enabled)');
      if (providers.has(provider.id)) throw new Error(`审阅功能已注册：${provider.id}`);
      providers.set(provider.id, provider); updateMenu();
      return () => { if (session?.provider === provider || lastRequest?.id === provider.id) close(); providers.delete(provider.id); updateMenu(); };
    }
  };
  updateMenu();
})();
