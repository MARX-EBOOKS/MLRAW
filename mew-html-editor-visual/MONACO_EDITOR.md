# Monaco 编辑工作台

```powershell
npm install
npm run start:editor -- -p 4127 -r "D:\马恩列总装\MEW_BRIEF"
```

打开 `http://localhost:4127/`。旧 textarea 编辑器保留在 `/legacy.html`。
`npm start` 启动对照阅读器；阅读器的源码模式也由 Monaco 接管，和可视化模式
共用同一工作副本及原生撤销栈，原自制高亮层和查找替换栏已移除。

对照阅读器默认仍是 PDF 与编辑区合窗。点页眉的“`双窗口`”后，当前窗口只保留
PDF 阅读器，并打开一个联控的 `index.html` 编辑器窗口；任一窗口切页都会让另一窗口
定位到对应页。分窗期间 dirty 标签、保存队列和版本冲突全部由 `index.html` 管理，
阅读器翻页不会自动保存。纯阅读器中的“`恢复合窗`”可恢复原模式。
`npm start` 已同时为联控编辑器提供文件 API；单独运行 `npm run start:editor` 时，
`index.html` 仍完全独立，不需要打开或启动 PDF 阅读器。

新入口是 `public/index.html`，实现是 `public/monaco-app.js`。
Monaco 接管源码编辑、语法高亮、选择、撤销重做、查找替换和每个文件的文档模型。
文件树、文件标签页、标签插入面板和 iframe 预览由同一工作台连接到这些模型；
它们不是 Monaco 自带的 VS Code Explorer/Webview，也不使用 Monaco 私有树 API。
原有浅色/深色配色、标签面板停靠/悬浮、拖动分栏和布局记忆继续可用。

- `Ctrl+S` 保存，`Ctrl+Shift+S` 全部保存。
- `Ctrl+F` 查找，`Ctrl+H` 替换；工具栏按钮打开原生查找替换面板。
- 标签按钮和 Alt 标签快捷键通过 `executeEdits` 写入，可以用 Monaco 原生撤销恢复。
- 文件切换保留各自的模型、光标/滚动位置和撤销历史；关闭时释放模型。
- 保存继续使用版本令牌和串行队列；磁盘变更只自动替换没有本地修改的文档。
- 关闭未保存文件可选保存、不保存或取消；保存失败时保留文件。

服务优先使用现有 `monaco/`，没有该目录时使用安装的 `monaco-editor@0.55.1`。
所有编辑器资源均从本机服务器加载。该版本快速切换模型时的 occurrence-highlight
请求可能产生取消异常，因此关闭了自动同词高亮；语法高亮、选择和搜索高亮仍然可用。
安装审计报告此版本的 DOMPurify 依赖有中等级别公告；本次未升级用户现有的 Monaco 版本。

验证：`npm run test:monaco` 和 `node tests/layout-browser.mjs` 使用无头 Edge。
可设置 `EDGE_PATH` 指向其他 Chromium 浏览器。测试使用临时文件目录，覆盖标签操作、
跨文件撤销、换行保持、保存、预览、外部刷新/冲突、关闭选择、快速打开竞态和布局。
`tests/document-browser.mjs` 继续针对保留的 legacy 编辑器及阅读器运行。
尚未验证真实 Git 平台提交或人工浏览器操作。
