// Shared popup renderer and current-file candidate navigation. Providers own content and actions.
(() => {
  'use strict';
  const toolbox = window.PdfSelectionDiff, providers = new Map();
  let session = null, generation = 0, pending = null, view = null, previewModels = [], disposals = [], lastRequest = null;
  let widget = null, widgetEditor = null, noticeAnchor = null, noticeLayout = null, manualTimer = null, composing = false;
  const menu = document.getElementById('replacementFeatures');
  const panel = document.createElement('section');
  panel.className = 'replacement-review'; panel.hidden = true;
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '审阅与批量替换');
  panel.innerHTML = `<div class="review-heading"><strong data-title></strong><span data-position></span><button type="button" data-switch hidden></button><button type="button" data-close aria-label="关闭审阅">×</button></div>
    <p data-status role="status"></p><div data-comparison></div><div data-options class="review-options"></div>
    <div class="review-controls"><button type="button" data-prev aria-label="上一条" title="上一条">↑</button><button type="button" data-next aria-label="下一条" title="下一条">↓</button><button type="button" data-apply>应用本条</button><button type="button" data-advance>应用并下一条</button><button type="button" data-save>替换&amp;保存</button></div>
    <details data-expanded><summary>差异预览与批量操作</summary><div class="review-controls"><label><input type="checkbox" data-file>整个文件 diff</label><button type="button" data-all>应用全部候选的所选方案</button></div><div data-preview data-review-preview></div></details>`;
  document.body.append(panel);
  const fields = new Map();
  const get = name => {
    if (!fields.has(name)) fields.set(name, panel.querySelector(`[data-${name}]`));
    return fields.get(name);
  };
  function editor() { return window.mewWorkbench?.editor || window.readerMonaco?.editor; }
  function workspace() {
    const owner = session?.editor.getDomNode()?.ownerDocument.defaultView;
    return owner?.mewWorkbench || owner?.readerMonaco;
  }
  function message(text) { get('status').textContent = text; get('status').hidden = !text; }
  function current() { return session?.items[session.position]; }
  function presentation() { return session?.provider.presentation?.(session.context, current()) || noticeLayout; }
  function valid() {
    return session && !session.stale && session.editor.getModel() === session.model
      && session.model.getValue() === session.source && session.model.getVersionId?.() === session.version
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
  function close(dismiss = true, restoreFocus = true) {
    clearTimeout(manualTimer); manualTimer = null; composing = false;
    ++generation; pending?.abort(); pending = null;
    disposals.splice(0).forEach(dispose => dispose());
    clearPreview(); panel.hidden = true; lastRequest = null; noticeAnchor = noticeLayout = null;
    if (widget) { widgetEditor.removeContentWidget(widget); widget = widgetEditor = null; document.body.append(panel); delete panel.dataset.contentWidget; panel.style.cssText = ''; }
    const previous = session; session = null;
    previous?.provider.onClose?.(previous.context);
    if (previous && dismiss) window.dispatchEvent(new CustomEvent('replacement-review-closed', { detail: {
      id: previous.provider.id, editor: previous.editor, model: previous.model
    } }));
    const owner = previous?.editor.getDomNode()?.ownerDocument.defaultView;
    if (previous && dismiss && owner && owner !== window) owner.dispatchEvent(new owner.CustomEvent('replacement-review-closed', { detail: {
      id: previous.provider.id, editor: previous.editor, model: previous.model
    } }));
    if (dismiss && restoreFocus && panel.dataset.side !== 'pdf') previous?.editor.focus();
  }
  function stale(event) {
    if (!session) return;
    session.stale = true; ++generation; clearPreview();
    queueManualRefresh(event); controls();
  }
  function queueManualRefresh(event) {
    const saved = session;
    if (!saved) return;
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
    if (!composing) manualTimer = setTimeout(() => void refreshAfterEdit(saved), 300);
  }
  async function refreshAfterEdit(saved) {
    if (session !== saved || !saved.manualPending || composing || saved.editor.getModel() !== saved.model) return;
    const request = ++generation, source = saved.model.getValue(), version = saved.model.getVersionId?.();
    const context = { ...saved.context, source, version, request: { ...saved.context.request, snapshot: null } };
    try {
      const sameReference = !saved.provider.isCurrent || saved.provider.isCurrent(context);
      if (!sameReference) { context.targets = null; context.request = { side: context.request?.side }; }
      const result = sameReference && saved.provider.refreshAfterEdit
        ? await saved.provider.refreshAfterEdit(context, saved.resumeOffset, saved)
        : { items: await saved.provider.provide(context), position: saved.position };
      if (session !== saved || request !== generation || saved.model.getValue() !== source
        || saved.model.getVersionId?.() !== version || (saved.provider.isCurrent && !saved.provider.isCurrent(context))) return;
      const items = validateCandidates(result);
      Object.assign(saved, result, { items, context, source, version, stale: false, manualPending: false });
      saved.choices = result.choices || new Map(saved.items.map(item => [item.id, saved.choices.get(item.id) || item.options[0].id]));
      render();
    } catch (error) { if (session === saved && request === generation) message(error.message); }
  }
  function controls() {
    const item = current(), ready = valid() && !!item && !session.applying && !session.saving;
    for (const name of ['apply', 'advance', 'all']) get(name).disabled = !ready || !session?.provider.apply || session.content?.apply === false;
    get('save').textContent = session?.manualSave ? '保存修改' : '替换&保存';
    get('save').disabled = !workspace()?.save || !!session?.saving || !!session?.applying || !(session?.manualSave
      ? session.editor.getModel() === session.model : ready && session?.provider.apply && session.content?.apply !== false);
    const blocked = !valid() || !!session?.applying;
    get('prev').disabled = blocked || session.position <= 0;
    get('next').disabled = blocked || session.position >= session.items.length - 1;
    get('position').textContent = session ? `${Math.min(session.position + 1, session.items.length)} / ${session.items.length}` : '';
  }
  async function open(id, suppliedEditor, focusId, fallbackPosition = 0, requestData = null) {
    const provider = providers.get(id), target = suppliedEditor || editor();
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
    const context = { editor: target, model, source, version, signal: controller.signal, toolbox, request: requestData };
    if (requestData?.snapshot) Object.assign(context, requestData.snapshot.context, { editor: target, model, source, version, signal: controller.signal, request: requestData });
    const modelChange = target.onDidChangeModel(() => close());
    const contentChange = target.onDidChangeModelContent(event => {
      if (event.isFlush || !session) close();
      else if (!session.applying) stale(event);
    });
    disposals.push(() => modelChange.dispose(), () => contentChange.dispose());
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
    const compositionStart = target.onDidCompositionStart?.(() => { composing = true; clearTimeout(manualTimer); });
    const compositionEnd = target.onDidCompositionEnd?.(() => {
      composing = false;
      if (session?.manualPending) { const saved = session; manualTimer = setTimeout(() => void refreshAfterEdit(saved), 300); }
    });
    disposals.push(() => compositionStart?.dispose(), () => compositionEnd?.dispose());
    // Keep an opening session so typing while extraction runs schedules a fresh calculation.
    session = { provider, editor: target, model, source, version, context, items: [], position: 0,
      choices: new Map(), manualSave: requestData?.snapshot?.manualSave || false, needsSave: requestData?.snapshot?.needsSave || false };
    const scroll = target.onDidScrollChange(() => place(target)); disposals.push(() => scroll.dispose());
    if (placement?.container) {
      const container = placement.container, move = () => place(target);
      container.addEventListener('scroll', move); disposals.push(() => container.removeEventListener('scroll', move));
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
      session = { provider, editor: target, model, source, version, context, items,
        position: found >= 0 ? found : Math.max(0, Math.min(fallbackPosition, items.length - 1)),
        manualSave: snapshot?.manualSave || false, needsSave: snapshot?.needsSave || false, choices: new Map(items.map(item => [item.id, snapshot?.choices.get(item.id) || item.options[0].id])) };
      render(!!requestData);
    } catch (error) { if (request === generation) {
      if (provider.isCurrent && !provider.isCurrent(context)) stale();
      else { message(error.message); controls(); }
    } }
    finally { if (pending === controller) pending = null; }
  }
  function render(preserveSelection = false) {
    if (!session) return;
    const item = current();
    session.content = session.provider.content?.(session, item) || {};
    const content = session.content;
    get('options').replaceChildren(); controls();
    message((content.message || '') + (session.needsSave ? ' 内容已修改，请保存。' : '')); comparison(content.comparison);
    get('title').textContent = content.title || session.provider.label;
    get('apply').textContent = content.applyLabel || '应用本条';
    for (const name of ['advance', 'expanded', 'all']) get(name).hidden = content[name] === false;
    if (item) {
      for (const value of content.options || []) {
        const label = document.createElement('label'), input = document.createElement('input');
        input.type = 'radio'; input.name = 'review-choice'; input.checked = session.choices.get(item.id) === value.id;
        input.onchange = () => { session.choices.set(item.id, value.id); render(); };
        label.append(input, document.createTextNode(value.label)); get('options').append(label);
      }
      selectField(preserveSelection); session.provider.onSelect?.(item, session.context);
    }
    void preview(); place(session.editor);
  }
  function comparison(rows = []) {
    get('comparison').replaceChildren();
    for (const row of rows) {
      const line = document.createElement('div');
      if (row.label) line.append(`${row.label}: `);
      for (const part of row.parts || []) {
        const span = document.createElement(part.changed ? 'mark' : 'span'); span.textContent = part.text; line.append(span);
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
    const selected = preserveSelection && session.editor.getSelection();
    const keep = selected && !selected.isEmpty();
    const range = keep ? selected : session.content?.range;
    session.anchor = range;
    if (range) {
      session.anchorOffset = session.model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
      if (!keep) {
        session.editor.setSelection(range);
        session.editor.revealRangeInCenterIfOutsideViewport(range);
      }
    }
    place(session.editor);
  }
  async function preview() {
    if (get('expanded').hidden || !get('expanded').open || !valid() || !current()) return;
    const saved = session, request = ++generation;
    try {
      const api = await window.MewEditorCore.loadMonaco();
      if (session !== saved || request !== generation || !valid() || !get('expanded').open) return;
      const data = await session.provider.preview?.(session, get('file').checked);
      if (!data || session !== saved || request !== generation || !valid()) return;
      const { before, after, language = 'plaintext' } = data;
      if (!view) view = api.editor.createDiffEditor(get('preview'), { automaticLayout: true, readOnly: true, originalEditable: false,
        renderSideBySide: false, minimap: { enabled: false }, scrollBeyondLastLine: false, diffAlgorithm: 'advanced' });
      clearPreview();
      previewModels = [api.editor.createModel(before, language), api.editor.createModel(after, language)];
      view.setModel({ original: previewModels[0], modified: previewModels[1] });
    } catch (error) { if (session === saved && request === generation) { clearPreview(); message(error.message); } }
  }
  async function apply(all, advance = false) {
    if (!valid()) { stale(); return; }
    const saved = session;
    if (!current() || !saved.provider.apply || saved.applying) return;
    saved.applying = true; controls();
    try {
      const result = await saved.provider.apply({ ...saved, context: { ...saved.context } }, all);
      if (session !== saved) return;
      const changed = saved.model.getValue() !== saved.source;
      Object.assign(saved, result, { applying: true });
      if (changed) saved.needsSave = true;
      Object.assign(saved.context, { source: saved.source, version: saved.version });
      if (saved.context.request) saved.context.request = { ...saved.context.request, snapshot: null };
      if (!valid()) { stale(); return; }
      render();
      saved.applying = false; controls();
      if (advance && !saved.items.length) await navigate(1);
      return true;
    } catch (error) {
      if (session !== saved) return;
      saved.applying = false;
      if (saved.model.getValue() !== saved.source) stale();
      message(error.message); controls();
    } finally { saved.applying = false; controls(); }
  }
  function navigate(direction) {
    if (!valid() || session.applying) return;
    const next = session.position + direction;
    if (next >= 0 && next < session.items.length) { session.position = next; render(); }
  }
  function place(target = session?.editor) {
    if (panel.hidden) return;
    const layout = presentation(), pdfSide = layout?.side === 'pdf';
    const node = pdfSide ? layout.container : target?.getDomNode(), rect = node?.getBoundingClientRect();
    if (layout) {
      panel.dataset.side = layout.side;
      get('switch').hidden = !layout.switchable;
      get('switch').textContent = layout.switchLabel || '';
    }
    const left = Math.max(8, rect?.left || 8), right = Math.min(innerWidth - 8, rect?.right || innerWidth - 8);
    panel.style.width = panel.classList.contains('compact') ? 'max-content' : `${Math.max(0, Math.min(460, right - left))}px`;
    panel.style.maxWidth = `${Math.max(0, Math.min(panel.classList.contains('compact') ? 280 : 460, right - left))}px`;
    panel.style.maxHeight = `${Math.max(100, Math.min(innerHeight - 16, (rect?.height || innerHeight) * (panel.classList.contains('compact') ? .45 : .7)))}px`;
    if (widget) { widgetEditor.layoutContentWidget(widget); return; }
    const range = session?.anchor;
    const position = !pdfSide && range ? target.getScrolledVisiblePosition({ lineNumber: range.startLineNumber, column: range.startColumn }) : null;
    const top = Math.max(8, rect?.top || 8), bottom = Math.min(innerHeight - 8, rect?.bottom || innerHeight - 8);
    const fragment = layout?.anchor || noticeAnchor;
    const anchor = Math.max(top, Math.min(bottom, fragment?.top ?? (rect?.top || 0) + (position?.top ?? 40)));
    const height = panel.getBoundingClientRect().height;
    const above = anchor - height - 8;
    panel.style.top = `${Math.max(top, Math.min(bottom - height, above >= top ? above : (fragment?.bottom ?? anchor + (position?.height || 20)) + 8))}px`;
    panel.style.left = `${Math.max(left, Math.min(right - panel.offsetWidth, fragment?.left ?? left + (position?.left || 0)))}px`;
  }
  async function switchSide() {
    if (!valid() || session.applying) return;
    const saved = session, item = current(), side = presentation()?.side === 'pdf' ? 'html' : 'pdf';
    const request = { ...saved.context.request, side, snapshot: {
      model: saved.model, source: saved.source, version: saved.version, context: saved.context,
      items: saved.items, choices: saved.choices, needsSave: saved.needsSave, manualSave: saved.manualSave
    } };
    const placement = saved.provider.presentation?.({ ...saved.context, request }, item);
    const destination = placement?.host;
    if (!destination) return;
    close(false);
    const opening = destination.open(saved.provider.id, saved.editor, item?.id, saved.position, request);
    const targetWindow = placement.window;
    // Re-select the existing browsing context while the click still has user
    // activation. Chromium can ignore focus() alone on the opener's window.
    if (targetWindow && targetWindow !== window) {
      if (!targetWindow.name) targetWindow.name = `mew-review-${window.crypto.randomUUID()}`;
      window.open('', targetWindow.name)?.focus();
    }
    placement.window?.focus();
    await opening;
    if (destination.isOpenFor(saved.provider.id, saved.editor)) {
      placement.window?.focus();
      placement.window?.document.querySelector('.replacement-review:not([hidden])')?.focus({ preventScroll: true });
    }
  }
  get('close').onclick = close;
  get('switch').onclick = () => void switchSide();
  get('prev').onclick = () => void navigate(-1);
  get('next').onclick = () => void navigate(1);
  get('apply').onclick = () => apply(false);
  get('advance').onclick = () => void apply(false, true);
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
      if (session === saved && result !== false && saved.model.getValue() === source) {
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
  document.addEventListener('pointerdown', event => {
    const position = session?.editor.getTargetAtClientPoint(event.clientX, event.clientY)?.position;
    const api = session?.editor.getDomNode()?.ownerDocument.defaultView.monaco;
    if (position && session.anchor && api?.Range.containsPosition(session.anchor, position)) return;
    if (!panel.hidden && !event.composedPath().includes(panel)) close(true, false);
  }, true);
  new ResizeObserver(() => place()).observe(panel);
  window.addEventListener('resize', () => place());
  window.addEventListener('pagehide', () => { close(); view?.dispose(); });
  window.ReplacementReview = {
    open, openForSelection, showNotice, close, refreshMenu: updateMenu,
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

// PDF comparison is one review provider. Selection synchronization remains independent.
(() => {
  'use strict';
  const host = window.ReplacementReview, toolbox = window.PdfSelectionDiff;
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
  const locator = toolbox.createLocator({}, {
    document, getPdf: () => viewer()?.pdfDocument, readPageFonts: toolbox.readPageFonts,
    isCurrent: pdf => viewer()?.pdfDocument === pdf,
    waitForIdle: () => new Promise(resolve => setTimeout(resolve, 0))
  });
  function presentation(context) {
    const reader = readerWindow() || window, source = context.editor?.getDomNode()?.ownerDocument.defaultView || window;
    const split = source !== reader, side = split ? context.request?.side || 'html' : 'pdf';
    const request = context.request, element = request?.anchorElement, box = request?.anchorBox;
    const rect = element?.isConnected && element.getBoundingClientRect();
    const anchor = rect && box ? { left: rect.left + box.x * rect.width, top: rect.top + box.y * rect.height,
      bottom: rect.top + (box.y + box.h) * rect.height } : request?.anchor;
    const destination = side === 'pdf' ? reader : source;
    return { side, switchable: split, switchLabel: side === 'pdf' ? '查看HTML' : '查看PDF', host: destination.ReplacementReview, window: destination,
      container: viewer()?.container, anchor };
  }
  function comparisonRows(value, compact = true) {
    if (typeof value?.html !== 'string' || typeof value?.pdf !== 'string') return [];
    let parts = toolbox.monacoDiff(value.html, value.pdf)?.parts || [{ ...value, changed: false }];
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
    return ['html', 'pdf'].map(side => ({ label: side.toUpperCase(), parts: parts.map(part => ({ text: part[side], changed: part.changed })) }));
  }
  function formatItems(index, targets = []) {
    if (!fontEnabled) return [];
    return toolbox.formatDifferences(index, targets.filter(Boolean)
      .flatMap(target => (index.connections.get(target) || []).map(connection => [connection, target])));
  }
  function formatMessage(items) {
    const formats = items.flatMap(item => item.formats || [item]);
    return ['italic', 'bold'].flatMap(key => [...new Set(formats.filter(item => typeof item.font[key] === 'boolean'
      && item.font[key] !== item.htmlFont[key]).map(item =>
        `${key === 'italic' ? '斜体' : '粗体'}不一致（HTML ${item.htmlFont[key] ? '是' : '否'} / PDF ${item.font[key] ? '是' : '否'}${key === 'bold' && item.font.scanBoldRatio ? '，扫描估计' : ''}）`))]).join('；');
  }
  function fontCandidates(index, targets, model) {
    return formatItems(index, targets).map(item => ({ ...item,
      range: toolbox.rangeAt(model, index.starts[item.sourceStart], index.ends[item.sourceEnd - 1]) }));
  }
  const isCurrent = context => context.pdf === viewer()?.pdfDocument;
  async function provide(context) {
    const pdf = context.pdf = viewer()?.pdfDocument;
    if (!pdf) throw new Error('请先在对照阅读器中打开 PDF。');
    if (!toolbox.monacoAvailable && !await toolbox.loadMonaco()) throw new Error('Monaco diff 未能加载，请刷新页面重试。');
    const request = context.request;
    if (request?.pdf === pdf && request.notice?.source?.index.source === context.source) {
      // Selection already supplies confirmed mappings and the rendered layer's
      // fonts. Do not block its popup on font analysis of the entire volume.
      context.targets = [...new Set([request.notice.target?.index, ...(request.targets || [])].filter(Boolean))];
      context.index = request.notice.source.index;
      return reviewItems(context.index, context.targets, request.notice, context.model);
    }
    const full = await (fontEnabled ? locator.indexFonts(pdf) : locator.indexDocument(pdf));
    if (context.signal.aborted) return [];
    if (!full || !isCurrent(context)) throw new Error('PDF 已变化，正在等待对照文件就绪。');
    const index = context.index = locator.editorSourceIndex(context.model);
    context.targets = [full];
    locator.prepareSource(index, context.targets, pdf);
    return reviewItems(index, context.targets, null, context.model);
  }
  function refreshCandidates(context, offset, previous) {
    // Review is a shrinking list: recheck edited candidates, retain all others.
    // Only a changed PDF reference needs a new discovery pass (handled by the host).
    const before = previous.source, after = context.source;
    const { start, oldEnd, newEnd } = toolbox.changedRange(before, after);
    const shift = (value, end = false) => value < start || value === start && !end ? value
      : value >= oldEnd ? value + newEnd - oldEnd : end ? newEnd : start;
    const oldIndex = context.index?.source === before ? context.index : locator.sourceIndex(before);
    const index = context.index = locator.editorSourceIndex(context.model, context.targets, oldIndex);
    const items = [], choices = new Map();
    for (const candidate of previous.items) {
      const a = oldIndex.starts[candidate.sourceStart] ?? before.length;
      const b = oldIndex.ends[candidate.sourceEnd - 1] ?? a;
      const left = locator.lowerBound(index.starts, shift(a));
      const right = locator.lowerBound(index.starts, shift(b, true));
      const touched = a <= oldEnd && b >= start;
      let updated;
      if (touched && candidate.comparison && !candidate.font) {
        const html = index.raw.slice(left, right), pdf = candidate.comparison.pdf;
        if (toolbox.significantText(html) === toolbox.significantText(pdf)) continue;
        // Compare only this candidate's revised text to its existing PDF reading.
        const notice = { source: { start: left, end: right }, html, pdf };
        const selected = candidate.selection && selectionCandidate(index, notice, context.model);
        updated = selected ? [selected] : toolbox.reviewCandidates(index, [], notice);
      } else if (touched && candidate.font) {
        // Retain format entries only while their original mismatch remains.
        const text = index.raw.slice(left, right);
        const htmlFont = index.formats.slice(left, right).find(style => ['italic', 'bold'].some(key =>
          typeof candidate.font[key] === 'boolean' && style[key] !== candidate.font[key]));
        if (!text || !htmlFont) continue;
        updated = [{ ...candidate, id: `font:${left}:${right}`, sourceStart: left, sourceEnd: right, text, htmlFont,
          formats: undefined,
          range: toolbox.rangeAt(context.model, shift(a), shift(b, true)) }];
      } else {
        updated = [{ ...candidate, sourceStart: left, sourceEnd: right,
          id: `${candidate.font ? 'font:' : ''}${left}:${right}`,
          preview: candidate.comparison || candidate.preview,
          range: candidate.range ? toolbox.rangeAt(context.model, shift(a), shift(b, true)) : undefined,
          options: candidate.options.map(option => ({ ...option, edits: option.edits.map(edit => ({ ...edit,
            start: shift(edit.start), end: shift(edit.end, true) })) })) }];
      }
      for (const item of updated) {
        items.push(item); choices.set(item.id, previous.choices.get(candidate.id) || item.options[0].id);
      }
    }
    const found = items.findIndex(item => (index.starts[item.sourceEnd] ?? after.length) > offset
      || (index.starts[item.sourceStart] ?? after.length) >= offset);
    return { items, choices, position: found < 0 ? items.length : found };
  }
  function reviewItems(index, targets, notice, model) {
    let text = enabled ? toolbox.reviewCandidates(index, targets, notice) : [];
    const selected = enabled && selectionCandidate(index, notice, model);
    if (selected) text = [...text.filter(item => item.sourceEnd <= selected.sourceStart && item.sourceStart < selected.sourceStart
      || item.sourceStart >= selected.sourceEnd && item.sourceEnd > selected.sourceEnd), selected].sort((a, b) => a.sourceStart - b.sourceStart);
    const formats = fontCandidates(index, targets, model);
    const positions = new Map();
    let cursor = 0;
    for (const item of formats) {
      while (cursor < text.length && text[cursor].sourceEnd < item.sourceStart) cursor++;
      const nearby = text[cursor];
      positions.set(item, nearby && nearby.sourceStart <= item.sourceEnd ? nearby.sourceStart : item.sourceStart);
    }
    const order = item => positions.get(item) ?? item.sourceStart;
    return [...text, ...formats].sort((a, b) => order(a) - order(b) || Number(!!a.font) - Number(!!b.font));
  }
  function selectionCandidate(index, notice, model) {
    const source = notice?.source;
    if (!source || index.raw.slice(source.start, source.end) !== notice.html) return null;
    const selected = toolbox.reviewCandidates(index, [], notice);
    if (!selected.length) return null;
    return { id: `${source.start}:${source.end}`, sourceStart: source.start, sourceEnd: source.end,
      selection: true, comparison: { html: notice.html, pdf: notice.pdf },
      range: toolbox.rangeAt(model, index.starts[source.start] ?? index.source.length,
        index.ends[source.end - 1] ?? index.starts[source.start] ?? index.source.length),
      options: [{ id: 'pdf', label: '替换', edits: selected.flatMap(item => item.options[0].edits) }] };
  }
  function content(state, item) {
    const edits = item?.options.find(value => value.id === state.choices.get(item.id))?.edits || [];
    const ranges = edits.length ? edits : item?.options.flatMap(value => value.edits) || [];
    return { message: item ? item.font ? formatMessage([item]) : '文字不一致' : state.items.length ? '已到末尾，可返回上一条。' : '没有可审阅的差异。',
      comparison: item?.font ? [] : comparisonRows(item?.preview || item?.comparison, !item?.selection),
      apply: !item?.font,
      range: item?.range || (ranges.length ? toolbox.rangeAt(state.model, Math.min(...ranges.map(edit => edit.start)), Math.max(...ranges.map(edit => edit.end))) : null),
      options: [], applyLabel: '替换', advance: false, expanded: false };
  }
  function apply(state, all) {
    const item = state.items[state.position];
    if (!all && item?.font) return state;
    const edits = (all ? state.items : [item]).flatMap(value => value.options.find(option => option.id === state.choices.get(value.id)).edits);
    const checked = toolbox.validateEdits(state.source, edits);
    const shift = offset => offset + checked.reduce((sum, edit) => sum + (edit.end <= offset ? edit.text.length - (edit.end - edit.start) : 0), 0);
    const overlaps = (start, end) => checked.some(edit => edit.start === start || (edit.start < end && edit.end > start)
      || (edit.start === edit.end && edit.start > start && edit.start < end));
    // Prepare surviving candidates against the old model before applying the edit.
    // Conflicting candidates are discarded; independent ranges move by the exact edit delta.
    const remaining = [];
    for (const [position, candidate] of state.items.entries()) {
      if ((all && !candidate.font) || candidate === item) continue;
      if (candidate.options.some(value => value.edits.some(edit => overlaps(edit.start, edit.end)))) continue;
      let range;
      if (candidate.range) {
        const start = state.model.getOffsetAt({ lineNumber: candidate.range.startLineNumber, column: candidate.range.startColumn });
        const end = state.model.getOffsetAt({ lineNumber: candidate.range.endLineNumber, column: candidate.range.endColumn });
        if (overlaps(start, end) && !candidate.font) continue;
        range = { start: shift(start), end: shift(end) };
      }
      remaining.push({ candidate, range, before: position < state.position,
        options: candidate.options.map(value => ({ ...value, edits: value.edits.map(edit => ({ ...edit, start: shift(edit.start), end: shift(edit.end) })) })) });
    }
    toolbox.applyEdits(state.editor, state.model, state.version, state.source, edits);
    const source = state.model.getValue(), version = state.model.getVersionId?.();
    const oldIndex = state.context.index?.source === state.source ? state.context.index : locator.sourceIndex(state.source);
    const index = state.context.index = locator.editorSourceIndex(state.model, state.context.targets, oldIndex);
    const choices = new Map();
    state.items = remaining.map(({ candidate, options, range }) => {
      const updated = { ...candidate, options };
      if (range) updated.range = toolbox.rangeAt(state.model, range.start, range.end);
      if (index) {
        for (const key of ['sourceStart', 'sourceEnd']) if (candidate[key] !== undefined) {
          const raw = oldIndex.starts[candidate[key]] ?? state.source.length;
          updated[key] = locator.lowerBound(index.starts, shift(raw));
        }
        const prefix = candidate.font ? 'font:' : '';
        if (candidate.id === `${prefix}${candidate.sourceStart}:${candidate.sourceEnd}`) {
          updated.id = `${prefix}${updated.sourceStart}:${updated.sourceEnd}`;
        }
        if (candidate.font) updated.text = index.raw.slice(updated.sourceStart, updated.sourceEnd);
        // The surrounding preview belongs to the previous source; the unchanged
        // candidate's own comparison remains accurate after independent edits.
        if (candidate.comparison) updated.preview = candidate.comparison;
      }
      choices.set(updated.id, state.choices.get(candidate.id));
      for (const value of options) toolbox.validateEdits(source, value.edits);
      return updated;
    });
    state.choices = choices;
    state.source = source; state.version = version;
    state.position = Math.min(remaining.filter(value => value.before).length, Math.max(0, state.items.length - 1));
    return state;
  }
  const review = {
    compact: true, content, apply, presentation, isCurrent, provide,
    refreshAfterEdit: refreshCandidates,
    onSelect(item, context) { selection()?.showReviewPointer(context.editor, item); },
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
  // Diff decorations and click ranges belong to review; selection supplies prepared mappings.
  const marks = new Map(), pageFontItems = new WeakMap();
  function clearMarks() {
    for (const state of marks.values()) { state.collection.clear(); state.dispose?.(); state.style.remove(); }
    marks.clear();
  }
  function onSources(event) {
    const { editor, index, targets, enabled } = event.detail;
    if (!editor?.createDecorationsCollection) return;
    let state = marks.get(editor);
    if (!state) {
      const doc = editor.getDomNode()?.ownerDocument || document, style = doc.createElement('style');
      style.textContent = '.mew-ocr-diff-line{border-left:3px solid #d58b24;margin-left:3px;cursor:pointer}.mew-ocr-diff-text{background:rgba(255,166,40,.3);border-bottom:1px solid #d58b24;cursor:pointer}.mew-ocr-diff-insert{border-left:2px solid #d58b24;margin-left:-1px;cursor:pointer}';
      doc.head.append(style);
      state = { collection: editor.createDecorationsCollection(), style };
      const clear = () => { state.collection.clear(); state.source = null; };
      const subscriptions = [editor.onDidChangeModel?.(clear), editor.onDidChangeModelContent?.(clear)];
      state.dispose = () => subscriptions.forEach(subscription => subscription?.dispose());
      marks.set(editor, state);
    }
    const connections = index ? targets.flatMap(target => (index.connections.get(target) || []).map(item => [item, target])) : [];
    if (enabled && toolbox.monacoAvailable && index) {
      if (state.source === index && connections.length === state.connections?.length
        && connections.every(([item, target], i) => item === state.connections[i][0] && target === state.connections[i][1])) return;
      state.collection.set(toolbox.sourceDecorations(index, connections, editor.getModel()));
      Object.assign(state, { source: index, connections });
    } else { state.collection.clear(); state.source = null; }
  }
  window.PdfReviewProvider = {
    readPageFonts: toolbox.readPageFonts,
    layerFonts(view, layer, refresh) {
      const page = view?.pdfPage, objects = page?.commonObjs, fonts = new Map();
      if (page?.getTextContent && !pageFontItems.has(page)) {
        pageFontItems.set(page, { items: [], fonts: new Map() });
        toolbox.readPageText(page).then(async content => {
          const items = content.items.filter(item => item.str?.length);
          const fonts = await toolbox.readPageFonts(page, items);
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
        const observed = item && toolbox.textItemFont(data?.fonts, item);
        if (observed) return observed;
        const id = item?.fontName || element.dataset?.fontName;
        const key = `${id}:${family}:${css.fontStyle}:${css.fontWeight}`;
        if (!fonts.has(key)) {
          const font = id && objects?.has(id) ? objects.get(id) : objects && [...objects].map(([, value]) => value)
            .find(value => value.loadedName && family.includes(value.loadedName));
          const style = data?.fonts.get(id) || toolbox.fontStyle(font, family, css);
          fonts.set(key, page?.getTextContent && !data?.fonts.has(id)
            ? { ...style, bold: null, italic: null, reason: '字体渲染模式检查中' } : style);
        }
        return fonts.get(key);
      };
    },
    selectionRange(editor, event, range) {
      // A text drag owns its full range, even when it ends on a diff marker.
      if (!event?.lineRange && !range.isEmpty?.()) return null;
      const collection = marks.get(editor)?.collection, position = event?.position || range.getStartPosition();
      for (let i = 0; i < (collection?.length || 0); i++) {
        const mark = collection.getRange(i);
        if (event?.lineRange ? mark?.intersectRanges(event.lineRange) : mark?.containsPosition(position)) return mark;
      }
      return null;
    }
  };
  // The independent selection module publishes data, never review UI calls.
  let listeningWindow = null;
  let dismissed = null, differenceRequest = 0;
  function onClose(event) {
    if (!['pdf-ocr', 'pdf-font'].includes(event.detail.id)) return;
    const { editor, model } = event.detail;
    dismissed = { editor, model, version: model.getVersionId?.(), range: editor.getSelection()?.toString(), interaction: selection()?.interactionId };
  }
  window.addEventListener('replacement-review-closed', onClose);
  async function onDifference(event) {
    if (!enabled && !fontEnabled) return;
    const data = event.detail, editor = data.editor, model = editor?.getModel();
    const request = ++differenceRequest, version = model?.getVersionId?.();
    if (!toolbox.monacoAvailable && !await toolbox.loadMonaco()) return;
    if (request !== differenceRequest || editor?.getModel() !== model || model?.getVersionId?.() !== version) return;
    const readerHost = listeningWindow?.ReplacementReview;
    const destination = ['pdf-ocr', 'pdf-font'].some(id => readerHost?.isOpenFor(id, editor)) ? readerHost
      : editor?.getDomNode()?.ownerDocument.defaultView.ReplacementReview || readerHost;
    if (destination !== host || data.pdf !== viewer()?.pdfDocument || (data.model && model !== data.model)) return;
    if (dismissed?.editor === editor && dismissed.model === model && dismissed.version === model?.getVersionId?.()
      && dismissed.range === editor?.getSelection()?.toString() && dismissed.interaction === data.interactionId) return;
    dismissed = null;
    const changed = data.notices.find(value => typeof value.html === 'string' && typeof value.pdf === 'string'
      && toolbox.monacoDiff(value.html, value.pdf)?.parts.some(part => part.changed));
    const mapping = changed || data.notices.find(value => value.source) || data.notices[0];
    const notice = mapping?.target ? { ...mapping,
      fonts: toolbox.fontRuns(mapping.target.index, mapping.target.start, mapping.target.end),
      text: mapping.target.index.raw.slice(mapping.target.start, mapping.target.end) } : mapping;
    if (!notice) return;
    const textDifference = !!changed;
    if (!textDifference) {
      if (notice.source && model && notice.source.index.source === model.getValue()) {
        const index = notice.source.index;
        const targets = [...new Set([notice.target?.index, ...(data.targets || [])].filter(Boolean))];
        // Compare the selected PDF layer even before background page mapping
        // has populated the source's connections (including exact text hits).
        if (notice.target && locator.normalized(index.raw.slice(notice.source.start, notice.source.end)).text
          === locator.normalized(notice.target.index.raw.slice(notice.target.start, notice.target.end)).text) {
          locator.rememberConnection(index, notice.source.start, notice.source.end, notice.target.index,
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
    if (!notice.source || !model || notice.source.index.source !== model.getValue()) {
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
  window.addEventListener('pagehide', () => { clearInterval(poll); clearMarks(); window.removeEventListener('pdf-selection-sources', onSources); window.removeEventListener('pdf-selection-reset', clearMarks); listeningWindow?.removeEventListener('pdf-selection-difference', onDifference); window.removeEventListener('replacement-review-closed', onClose); unregister.forEach(dispose => dispose()); });
})();
