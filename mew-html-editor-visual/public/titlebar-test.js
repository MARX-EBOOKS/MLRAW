// Shared browser title-bar control for the editor and reader.
// No service worker, storage, document edits, or application event interception.
(() => {
  'use strict';
  const header = document.querySelector('body > header');
  if (!header || document.getElementById('titlebar-test-button')) return;
  const reader = header.classList.contains('site-header');
  const style = document.createElement('style');
  style.textContent = `
    body > header #titlebar-test-button { flex: none; white-space: nowrap; }
    html.titlebar-test-overlay body > header {
      margin-left: env(titlebar-area-x, 0px);
      margin-top: env(titlebar-area-y, 0px);
      width: env(titlebar-area-width, 100%);
      height: max(32px, env(titlebar-area-height, 32px));
      min-height: max(32px, env(titlebar-area-height, 32px));
      app-region: drag;
      -webkit-app-region: drag;
    }
    html.titlebar-test-overlay body > header::after {
      content: ''; flex: 0 0 28px; align-self: stretch;
    }
    html.titlebar-test-overlay body > header :is(button, input, select, label, a, details, nav) {
      app-region: no-drag;
      -webkit-app-region: no-drag;
    }
    #titlebar-test-dialog {
      max-width: min(520px, calc(100vw - 32px)); padding: 20px;
      background: var(--panel); color: var(--ink); border: 1px solid var(--line);
      border-radius: 6px; font: 14px/1.65 'Segoe UI', 'Microsoft YaHei', sans-serif;
    }
    #titlebar-test-dialog::backdrop { background: #0006; }
    #titlebar-test-dialog h2 { margin: 0; font-size: 17px; }
    #titlebar-test-dialog button { margin-right: 8px; }
  `;
  document.head.append(style);
  const button = document.createElement('button');
  button.id = 'titlebar-test-button';
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  if (reader) header.querySelector('.topActions .menuPanel').append(button);
  else header.querySelector('.inlineActions').append(button);

  const dialog = document.createElement('dialog');
  dialog.id = 'titlebar-test-dialog';
  dialog.setAttribute('aria-labelledby', 'titlebar-test-title');
  dialog.innerHTML = `
    <h2 id="titlebar-test-title">缩小标题栏</h2>
    <p data-state role="status"></p>
    <button type="button" data-close>关闭</button>`;
  document.body.append(dialog);
  const overlay = navigator.windowControlsOverlay;
  let installPrompt;
  const theme = document.createElement('meta');
  theme.name = 'theme-color';
  document.head.append(theme);
  function update() {
    const active = Boolean(overlay?.visible);
    document.documentElement.classList.toggle('titlebar-test-overlay', active);
    button.textContent = '缩小标题栏';
    button.title = active ? '标题栏已缩小；点击查看恢复方法' : '选择使用应用窗口合并浏览器标题栏';
    dialog.querySelector('[data-state]').textContent = active
      ? '已开启。可在窗口菜单中恢复标题栏。'
      : !isSecureContext ? '请使用 localhost 或 HTTPS 地址。'
      : '请在已安装应用的窗口菜单中开启“隐藏标题栏”；普通 --app 窗口不支持。';
    theme.content = getComputedStyle(header).backgroundColor;
  }
  button.addEventListener('click', async () => {
    if (installPrompt) {
      const prompt = installPrompt;
      installPrompt = null;
      try { await prompt.prompt(); }
      catch {
        update();
        dialog.showModal();
      }
      return;
    }
    update();
    dialog.showModal();
  });
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; update(); });
  overlay?.addEventListener('geometrychange', update);
  new MutationObserver(update).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  update();
})();
