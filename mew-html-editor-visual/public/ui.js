// index.html UI: layout, tree, tabs, preview, theme and workbench controls.
(() => {
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const fileLabel = path => path.split('/').pop() || path || 'Untitled';

  function note(message) {
    $('status').textContent = message;
    setTimeout(() => {
      if ($('status').textContent === message) $('status').textContent = '';
    }, 2500);
  }

  function setupLayout() {
    const key = 'mew-editor-layout-v1';
    const root = document.documentElement;
    const main = document.querySelector('main');
    const defaults = { tree: 220, preview: 340, treeOpen: true, previewOpen: true };
    const closeAt = 24;
    let saved;
    try { saved = JSON.parse(localStorage.getItem(key)); } catch {}
    const layout = { ...defaults };
    for (const name of ['tree', 'preview']) {
      if (Number.isFinite(saved?.[name])) layout[name] = saved[name];
    }
    for (const name of ['treeOpen', 'previewOpen']) {
      if (typeof saved?.[name] === 'boolean') layout[name] = saved[name];
    }
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const persist = () => {
      try { localStorage.setItem(key, JSON.stringify(layout)); } catch {}
    };
    const limits = name => {
      const otherName = name === 'tree' ? 'preview' : 'tree';
      const other = layout[`${otherName}Open`] ? layout[otherName] : 0;
      const min = name === 'tree' ? 140 : 200;
      return [min, Math.max(min, main.clientWidth - 332 - other)];
    };
    function render() {
      for (const name of ['tree', 'preview']) {
        const [min, max] = limits(name);
        layout[name] = clamp(layout[name], min, max);
        root.style.setProperty(`--${name}-width`, `${layout[name]}px`);
        const splitter = $(`${name}Splitter`);
        const pane = $(name === 'tree' ? 'explorerPane' : 'previewPane');
        const toggle = $(`${name}PaneToggle`);
        const open = layout[`${name}Open`];
        root.classList.toggle(`${name}-pane-closed`, !open);
        pane.hidden = !open;
        splitter.hidden = !open;
        toggle.textContent = `${open ? '隐藏' : '显示'}${name === 'tree' ? '文件树' : '预览'}`;
        toggle.setAttribute('aria-pressed', String(open));
        splitter.setAttribute('aria-valuemin', min);
        splitter.setAttribute('aria-valuemax', max);
        splitter.setAttribute('aria-valuenow', Math.round(layout[name]));
      }
    }
    function setPaneOpen(name, open) {
      layout[`${name}Open`] = open;
      render();
      persist();
    }
    for (const name of ['tree', 'preview']) {
      const splitter = $(`${name}Splitter`);
      const direction = name === 'tree' ? 1 : -1;
      $(`${name}PaneToggle`).addEventListener('click', () => setPaneOpen(name, !layout[`${name}Open`]));
      splitter.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        const x = event.clientX;
        const width = layout[name];
        let requested = width;
        splitter.setPointerCapture(event.pointerId);
        splitter.focus();
        splitter.classList.add('dragging');
        document.body.classList.add('resizing');
        const move = moveEvent => {
          requested = width + direction * (moveEvent.clientX - x);
          layout[name] = requested;
          render();
        };
        const end = () => {
          splitter.removeEventListener('pointermove', move);
          for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) splitter.removeEventListener(type, end);
          if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
          splitter.classList.remove('dragging');
          document.body.classList.remove('resizing');
          if (requested <= closeAt) {
            layout[name] = width;
            layout[`${name}Open`] = false;
          }
          render();
          persist();
        };
        splitter.addEventListener('pointermove', move);
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) splitter.addEventListener(type, end);
      });
      splitter.addEventListener('dblclick', () => {
        layout[name] = defaults[name];
        render();
        persist();
      });
      splitter.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const [min, max] = limits(name);
        layout[name] = event.key === 'Home' ? min : event.key === 'End' ? max
          : layout[name] + (event.key === 'ArrowRight' ? 1 : -1) * direction * (event.shiftKey ? 40 : 10);
        render();
        persist();
      });
    }
    $('layoutReset').addEventListener('click', () => {
      Object.assign(layout, defaults);
      render();
      persist();
      window.dispatchEvent(new Event('mew-tag-panel-reset'));
    });
    new ResizeObserver(render).observe(main);
    render();
  }

  const tree = (() => {
    let options;
    let checking = false;
    let renderedText = '';
    let refreshTimer = 0;
    let retryDelay = 1000;

    function configure(nextOptions) { options = nextOptions; }

    async function load(rel = '', host = $('tree'), open = new Set()) {
      const data = await options.read(rel);
      $('rootPath').textContent = data.root;
      const box = rel ? document.createElement('div') : host;
      if (rel) box.className = 'indent';
      box.innerHTML = '';
      for (const entry of data.entries) {
        const row = document.createElement('div');
        row.className = 'item';
        row.dataset.path = entry.path;
        row.dataset.type = entry.type;
        row.title = entry.type === 'file' ? 'Click to open in this window.' : 'Click to expand.';
        row.innerHTML = `<span>${entry.type === 'dir' ? '+' : '-'}</span><span class="name">${escapeHtml(entry.name)}</span>`;
        row.tabIndex = 0;
        row.setAttribute('role', 'treeitem');
        if (entry.type === 'dir') row.setAttribute('aria-expanded', String(open.has(entry.path)));
        row.onkeydown = event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            row.click();
          }
        };
        row.onclick = event => {
          event.stopPropagation();
          if (entry.type === 'dir') return toggle(row, entry.path).catch(error => note(error.message));
          options.open(entry.path);
        };
        box.append(row);
        if (entry.type === 'dir' && open.has(entry.path)) {
          row.firstChild.textContent = '-';
          await load(entry.path, row, open);
        }
      }
      if (rel) host.after(box);
      box.querySelector(`.item[data-path="${CSS.escape(options.activePath())}"]`)?.classList.add('active');
    }

    async function toggle(row, rel) {
      const next = row.nextElementSibling;
      if (next?.classList.contains('indent')) {
        next.remove();
        row.setAttribute('aria-expanded', 'false');
        row.firstChild.textContent = '+';
        return;
      }
      row.firstChild.textContent = '-';
      row.setAttribute('aria-expanded', 'true');
      await load(rel, row);
      filter();
    }

    function openDirectories() {
      return new Set([...document.querySelectorAll(".item[data-type='dir']")]
        .filter(row => row.nextElementSibling?.classList.contains('indent'))
        .map(row => row.dataset.path));
    }

    async function refresh() {
      if (checking) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, 80);
        return;
      }
      checking = true;
      try {
        const nextTree = document.createElement('div');
        await load('', nextTree, openDirectories());
        const nextText = nextTree.textContent;
        // Restore the DOM even when a prior render was cleared without changing
        // the directory contents (for example while replacing application UI).
        if (renderedText !== nextText || !$('tree').childElementCount) {
          $('tree').replaceChildren(...nextTree.childNodes);
          if (renderedText) note('File tree updated');
          filter();
        }
        renderedText = nextText;
        retryDelay = 1000;
      } catch (error) {
        note(`文件树加载失败：${error.message}`);
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10000);
      } finally {
        checking = false;
      }
    }

    function scheduleRefresh() {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 80);
    }

    function filter() {
      const query = $('treeFilter').value.toLowerCase();
      document.querySelectorAll('#tree .item').forEach(row => {
        row.hidden = row.dataset.type !== 'dir' && !row.dataset.path.toLowerCase().includes(query);
      });
    }

    function setActive(path = '') {
      document.querySelectorAll('#tree .item').forEach(row => {
        row.classList.toggle('active', row.dataset.path === path);
        row.setAttribute('aria-selected', String(row.dataset.path === path));
      });
    }

    function collapse() {
      document.querySelectorAll('#tree > .indent').forEach(element => element.remove());
      document.querySelectorAll('#tree .item[data-type="dir"]').forEach(row => {
        row.firstChild.textContent = '+';
        row.setAttribute('aria-expanded', 'false');
      });
    }

    async function reveal(path) {
      const parts = path.split('/');
      parts.pop();
      let parent = '';
      for (const part of parts) {
        parent += (parent ? '/' : '') + part;
        const row = document.querySelector(`#tree .item[data-path="${CSS.escape(parent)}"]`);
        if (row && !row.nextElementSibling?.classList.contains('indent')) await toggle(row, parent);
      }
      $('treeFilter').value = '';
      filter();
      setActive(path);
      document.querySelector('#tree .active')?.scrollIntoView({ block: 'nearest' });
    }

    return { configure, refresh, scheduleRefresh, filter, setActive, collapse, reveal };
  })();

  function mountTagPanel({ tags, attrs, storageKey, onTag, onAttr, onNavigate, onEditorScale }) {
    $('tagBar').innerHTML = [
      ...tags.map((tag, index) => `<button class="tag" data-i="${index}" title="${escapeHtml(tag.title)}">${escapeHtml(tag.label)}</button>`),
      '<span class="spacer"></span>',
      ...attrs.map((attr, index) => `<button class="tag attrTag" data-attr="${index}" title="${escapeHtml(attr.title)}">${escapeHtml(attr.label)}</button>`),
      '<span class="spacer"></span>',
      '<button id="tagPrevFileBtn" class="tag attrTag tagFileNav" data-nav="-1" title="上一文件；切换前自动保存">←</button>',
      '<button id="tagNextFileBtn" class="tag attrTag tagFileNav" data-nav="1" title="下一文件；切换前自动保存">→</button>'
    ].join('');
    $('tagBar').onclick = event => {
      const tag = event.target.closest('button[data-i]');
      const attr = event.target.closest('button[data-attr]');
      const nav = event.target.closest('button[data-nav]');
      if (tag) onTag(tags[Number(tag.dataset.i)]);
      if (attr) onAttr(attrs[Number(attr.dataset.attr)]);
      if (nav) onNavigate(Number(nav.dataset.nav));
    };
    let oldLayout = {};
    try { oldLayout = JSON.parse(localStorage.getItem('mew-editor-layout-v1') || '{}'); } catch {}
    window.MewTagPanel.mount({
      content: '#tagBar',
      host: '.editorPane',
      storageKey,
      initialEditorScale: oldLayout.editorScale,
      initialTagScale: oldLayout.scale,
      setEditorScale(scale) {
        document.documentElement.style.setProperty('--editor-scale', scale);
        onEditorScale(scale);
      },
      editorSelector: '#monacoEditor'
    });
  }

  function editorScale() {
    return Math.min(1.6, Math.max(.8,
      Number.parseFloat(document.documentElement.style.getPropertyValue('--editor-scale')) || 1));
  }

  function renderTabs(documents, active) {
    const tabs = $('tabs');
    tabs.innerHTML = [...documents].map(document => `<button class="tab${document === active ? ' active' : ''}" data-path="${escapeHtml(document.path)}" title="${escapeHtml(document.path)}"><span class="tabName">${escapeHtml(fileLabel(document.path))}${document.dirty ? ' *' : ''}</span><span class="tabClose" data-close="${escapeHtml(document.path)}" title="Close">×</span></button>`).join('');
    tabs.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderDocumentState(document, documents) {
    $('fileName').textContent = document ? document.path + (document.dirty ? ' *' : '') : 'No file open';
    const tagTitle = $('tagPanelTitle');
    tagTitle.textContent = document ? `标签 · ${fileLabel(document.path)}` : '标签';
    tagTitle.title = document?.path || '';
    $('tagPrevFileBtn').disabled = !document;
    $('tagNextFileBtn').disabled = !document;
    renderTabs(documents, document);
  }

  function themeColors() {
    const style = getComputedStyle(document.body);
    return { bg: style.getPropertyValue('--bg').trim(), ink: style.getPropertyValue('--ink').trim() };
  }

  function renderPreview({ path, cssText, html, rawUrl }) {
    const preview = $('preview');
    preview.hidden = false;
    const dir = path.split('/').slice(0, -1).join('/');
    const { bg, ink } = themeColors();
    const css = `${cssText ? `<style>${cssText}</style>` : '<link rel="stylesheet" href="/mewde.css">'}<style>body{background:${bg};color:${ink}}</style>`;
    const baseUrl = rawUrl?.(dir, true) || `/raw/${encodeURI(dir)}${dir ? '/' : ''}`;
    preview.srcdoc = `<base href="${baseUrl}">` + css + html;
  }

  function clearPreview() {
    $('preview').hidden = true;
    $('preview').srcdoc = '';
  }

  function setDark(monaco, on, onChanged) {
    document.body.classList.toggle('dark', on);
    localStorage.setItem('mewDark', on ? '1' : '0');
    $('darkBtn').textContent = on ? 'Light' : 'Dark';
    const style = getComputedStyle(document.body);
    const color = name => style.getPropertyValue('--' + name).trim().replace(/^#([a-f0-9])([a-f0-9])([a-f0-9])$/i, '#$1$1$2$2$3$3');
    monaco.editor.defineTheme('mew', {
      base: on ? 'vs-dark' : 'vs', inherit: true,
      rules: [
        { token: 'tag', foreground: color('tag').slice(1) },
        { token: 'attribute.name', foreground: color('attr').slice(1) },
        { token: 'attribute.value', foreground: color('string').slice(1) },
        { token: 'comment', foreground: color('comment').slice(1) }
      ],
      colors: {
        'editor.background': color('bg'), 'editor.foreground': color('text'),
        'editor.selectionBackground': color('sel'), 'editorLineNumber.foreground': color('muted'),
        'editorWidget.background': color('panel'), 'editorWidget.border': color('line'),
        'input.background': color('field'), 'input.foreground': color('ink'),
        'editorCursor.foreground': color('ink')
      }
    });
    monaco.editor.setTheme('mew');
    onChanged();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }

  function closeMenus(except) {
    document.querySelectorAll('.menu[open]').forEach(menu => {
      if (menu !== except) menu.open = false;
    });
  }

  function askClose(document) {
    $('closeMessage').textContent = `${document.path} 有未保存的修改，是否保存？`;
    const dialog = $('closeDialog');
    return new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
      dialog.returnValue = 'cancel';
      dialog.showModal();
    });
  }

  function askFileName({ mode, directory, initialName = '' }) {
    const dialog = $('fileDialog');
    const form = $('fileDialogForm');
    const input = $('fileNameInput');
    $('fileDialogTitle').textContent = mode === 'new' ? '新建文件' : '另存为';
    $('fileDialogSubmit').textContent = mode === 'new' ? '创建' : '保存';
    $('fileDialogDirectory').textContent = directory || '工作区根目录';
    $('fileDialogError').textContent = '';
    input.value = initialName;
    return new Promise(resolve => {
      const finish = value => {
        form.removeEventListener('submit', submit);
        dialog.querySelector('[data-cancel]').removeEventListener('click', cancel);
        dialog.removeEventListener('cancel', onCancel);
        resolve(value);
      };
      const cancel = () => { dialog.close(); finish(null); };
      const onCancel = event => { event.preventDefault(); cancel(); };
      const submit = event => {
        event.preventDefault();
        const name = input.value.trim();
        let error = '';
        if (!name) error = '请输入文件名。';
        else if (name === '.' || name === '..' || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) error = '文件名不能包含路径或 Windows 保留字符。';
        else if (/[. ]$/.test(name)) error = '文件名不能以空格或句点结尾。';
        else if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) error = '这是 Windows 保留文件名。';
        if (error) { $('fileDialogError').textContent = error; input.focus(); return; }
        dialog.close();
        finish(name);
      };
      form.addEventListener('submit', submit);
      dialog.querySelector('[data-cancel]').addEventListener('click', cancel);
      dialog.addEventListener('cancel', onCancel);
      dialog.showModal();
      input.focus();
      input.select();
    });
  }

  function bindWorkbench(actions) {
    $('newFileBtn').onclick = actions.newFile;
    $('saveBtn').onclick = actions.save;
    $('saveAsBtn').onclick = actions.saveAs;
    $('saveAllBtn').onclick = actions.saveAll;
    $('undoBtn').onclick = actions.undo;
    $('redoBtn').onclick = actions.redo;
    $('findBtn').onclick = actions.find;
    $('prevFileBtn').onclick = () => actions.navigate(-1);
    $('nextFileBtn').onclick = () => actions.navigate(1);
    $('newWinBtn').onclick = actions.openWindow;
    $('closeSavedBtn').onclick = () => actions.closeAll(true);
    $('closeAllBtn').onclick = () => actions.closeAll(false);
    $('darkBtn').onclick = actions.toggleDark;
    $('fullBtn').onclick = toggleFullscreen;
    $('refreshBtn').onclick = actions.refreshPreview;
    $('openRawBtn').onclick = actions.openRaw;
    $('treeRefreshBtn').onclick = tree.refresh;
    $('treeCollapseBtn').onclick = tree.collapse;
    $('treeRevealBtn').onclick = () => tree.reveal(actions.activePath()).catch(error => note(error.message));
    $('treeFilter').oninput = tree.filter;
    $('tabs').onclick = event => {
      const close = event.target.closest('[data-close]');
      if (close) return actions.closeDocuments([close.dataset.close]);
      const tab = event.target.closest('[data-path]');
      if (tab) actions.activateDocument(tab.dataset.path);
    };
    $('fileMenu').onclick = event => {
      if (event.target.closest('button')) $('fileMenu').open = false;
    };
    document.addEventListener('pointerdown', event => closeMenus(event.target.closest('.menu')));
    if (window.MEWBackend) {
      $('newFileBtn').hidden = $('saveAsBtn').hidden = true;
      $('submitChangeBtn').hidden = $('gitConfigBtn').hidden = false;
      $('submitChangeBtn').onclick = () => window.MEWBackend.submitChanges().catch(error => note(error.message));
      $('gitConfigBtn').onclick = () => { location.href = '../git-editor.html'; };
    }
  }

  setupLayout();
  window.MewEditorUI = {
    $, note, tree, mountTagPanel, editorScale, renderTabs, renderDocumentState,
    themeColors, renderPreview, clearPreview, setDark, askClose, askFileName, bindWorkbench,
    isDark() { return document.body.classList.contains('dark'); },
    setReaderLinkedTitle() { document.title = 'MEW Monaco Editor · 阅读器联控'; },
    languageLabel(monaco, id) {
      const language = monaco.languages.getLanguages().find(item => item.id === id);
      return language?.aliases?.[0] || id;
    },
    setLanguage(text) { $('languageInfo').textContent = text; },
    setPosition(line, column) { $('positionInfo').textContent = `Ln ${line}, Col ${column}`; },
    showMonacoError(error) { $('status').textContent = `Monaco 加载失败：${error.message || error}`; }
  };
})();
