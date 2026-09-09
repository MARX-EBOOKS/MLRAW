# MEW HTML / PDF Reader

这是从 `mew-html-editor-vscode` 标签编辑扩展继续开发的独立 VS Code 扩展。HTML 使用 VS Code 原生文本编辑器；PDF 像 `mathematic.vscode-pdf` 一样注册为 VS Code 只读 Custom Editor，并在其中运行 PDF.js。标签页被用户执行“移到新窗口”后仍会继续接收同步消息；重新打开工作区/文件夹时，由 VS Code 根据真实 PDF URI 恢复另窗编辑器，扩展再恢复对应 HTML 和页码映射。

## 配置

把 `mew-reader.example.json` 复制为 HTML 项目中的 `.mew-reader.json`。扩展从当前 HTML 所在目录向上查找配置，直到工作区根目录。也可以设置 `mewReader.configFile` 指定 JSON；相对路径以所属工作区文件夹为基准。

如果一路找不到 JSON，或者当前文件不属于配置中的卷册，标签栏仍按原 `mew-html-editor-vscode` 的方式工作：前后按钮按 VS Code Explorer 排序切换同目录普通文件，并在首尾循环。

单卷配置示例见 `mew-reader.example.json`。多卷配置使用 `{ "volumes": [ ... ] }`，每个条目可配置 `id`、`title`、`shortTitle`、`htmlRoot`、`pdf`、`pagePattern` 和 `pageLabel`。

- `pagePattern` 必须包含命名捕获组 `(?<page>...)`，或把页码放在第一个捕获组。
- `pageLabel` 默认 `{page}`，用来把 HTML 页码映射到 PDF Page Label。
- 相对路径均以 JSON 文件所在目录为基准。
- 上一页/下一页只走实际存在的匹配 HTML 页面，不首尾循环；切换文件时保留 VS Code 的未保存状态，由 VS Code 统一管理保存。
- PDF 内滚动到带数字前缀的 Page Label 时会直接反向打开相应 HTML，不再触发保存或等待保存。
- PDF 页眉提供左右/上下翻页模式、扫描件亮度与背景/文字颜色、反色、页码跳转、前后页和缩放控件；这些显示设置保存在 PDF Webview 状态中。
- 本地 PDF（≤128 MiB）由扩展直接读取，通过二进制消息交给 PDF.js Worker；避免 Webview 文件服务中转和 Base64 编码。更大的文件和非本地 URI 使用显式 Range 读取；不支持 Range 的文件提供方只读取一次完整响应。翻页和重复同步同一卷复用已打开文档，页面按需渲染。
- Worker 源码在 Webview 中读取，再从 Blob 启动真实后台线程；字体、图片解码 WASM 由所属 Webview 代理读取，ICC 色彩配置预先准备为本地 Blob。这样避开 VS Code 对 Worker 资源请求的约 30 秒超时，并保留 PDF.js 的图像解码和色彩管理。

## 性能验证

`node test/pdf-vscode.mjs <PDF绝对路径>` 启动独立 VS Code 开发实例，测试从 PDF Webview 启动到第 300 页完成渲染的时间，并检查真实 Worker、翻页、同卷复用、100% 缩放、翻页方向与显示设置。通过标准为目标页小于 5 秒；不包括 VS Code 应用本身的冷启动。结果和截图写入 `test/artifacts/`。

2026-09-09，本机 VS Code 1.136.2：69.9 MB / 935 页原来约 31 秒，修复后约 1 秒；54.1 MB / 1,016 页约 1.6 秒；两卷真实扫描页合成的 95.4 MB / 1,763 页测试文件约 2.1 秒。未清空操作系统文件缓存，不代表所有机器、网络文件或复杂单页都能达到相同耗时。源 PDF 内容不改写、不降采样。

## 开发与安装

```powershell
npm install
npm run check
npm run package
```

然后在 VS Code 中安装生成的 `.vsix`。首次创建 PDF 页签的位置由 `mewReader.pdfOpenLocation` 控制：`beside` 为右侧、`active` 为当前编辑器组、`newWindow` 会调用当前 VS Code 的原生“将编辑器移到新窗口”命令。创建后也可随时手动移动 PDF 页签；后续同步不会调用 `reveal()` 把它移回。
