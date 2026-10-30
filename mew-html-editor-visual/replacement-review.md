# 编辑器审阅弹窗与前后条导航

Monaco 一侧通过 Content Widget 挂载共用弹窗，由编辑器管理锚点和滚动定位，布局变化时更新尺寸，关闭、切换模型或释放编辑器时移除控件。普通编辑器未提供完整 Content Widget API 时，继续使用原有固定定位与滚动跟随逻辑；PDF 一侧保留现有定位方式。

PDF 审阅使用原有紧凑弹窗，每次显示一个候选，通过前后条按钮切换差异；候选列表中文字差异排在格式差异之前。替换并保存沿用同模式候选替换规则；预览和差异高亮保持原有行为。

打开差异或选择文字后，PDF 指针高亮当前同模式候选组，不依赖“预览”开关；“预览”在 Monaco 中按字符显示该组的修改，“替换&保存”应用同一组。选中的词干或短语沿用 Monaco 匹配并保留大小写及词尾；单字符差异只在相同词语上下文中分组。关闭弹窗后恢复默认差异高亮。

关闭 PDF 默认差异高亮时，点击差异或选择文字仍显示当前同模式组的 PDF 高亮；关闭弹窗后清除该组高亮。

打开差异或选择文字后，PDF 指针高亮当前同模式候选组，不依赖“预览”开关；“预览”在 Monaco 中按字符显示该组的修改，“替换&保存”应用同一组。选中的词干或短语沿用 Monaco 匹配并保留大小写及词尾；单字符差异只在相同词语上下文中分组。关闭弹窗后恢复默认差异高亮。

`index.html` 和 `reader.html` 共用“审阅”按钮及“审阅选项”菜单。按钮直接打开 PDF 差异审阅；双窗口时使用当前配对编辑器，同时显示源码与 PDF 弹窗。

- `public/pdfdiff/pdf-review-provider.js`：统一加载入口；`PdfLocator` 负责 PDF 文字、字体元数据和渲染层样式读取、共享读取缓存及索引准备；管理 PDF 文字/格式候选、差异标记和替换操作，向共用弹窗提供数据与动作。
- `public/pdfdiff/pdf-selection-diff.js`：`PdfSourceIndex` 对已准备的数据执行定位、双向映射、文字与格式比较、装饰和编辑计算，以及共用编辑事务；不读取 PDF 页面或 DOM 样式。
- `public/pdfdiff/replacement-review.js`：共用弹窗、会话、前后条导航、保存和分窗切换，以及通用文字范围测量、叠层绘制、Monaco 标记缓存、选区命中与清理；提供 `ReplacementReview` 注册接口和 `ReviewHighlights.create()`，每个高亮调用方创建独立实例。
- `public/pdfdiff/pdf-selection.js`：PDF 与源码选区的双向定位、选区跟踪和滚动；发布已准备好的映射数据，不创建弹窗或判断字体差异。

Provider 提供 PDF 高亮数据，由独立的 `ReviewHighlights` 实例测量、合并、绘制、缓存与清理；选区模块仅传入映射后的范围。

其他功能可以载入 `replacement-review.js`，调用 `ReviewHighlights.create({ document, lowerBound, classes })`。
`lowerBound(values, value, key)` 是调用方已有的有序索引查找函数；`classes` 可配置 `selection/pointer/caret` 类名。
`measureHighlights(container, index, hits, focusHit)` 接收 `index.raw`、按文字顺序排列的 `index.parts: [{ node, start, end }]` 和文字范围，返回相对坐标。
实例提供 `paintHighlight/clearHighlights/getHighlight`；`updateSource(editor, key, decorations, css)` 按调用方的版本键缓存 Monaco 标记，`decorations` 只在缓存失效时调用。
`selectionRange(editor, event, range)` 查询当前标记，`dispose()` 清理该实例的叠层、样式和订阅。

各功能只提交展示数据与操作回调，不创建自己的弹窗。PDF 紧凑弹窗保留对照、预览、替换并保存和前后条；“预览”是开关，开启或关闭 Monaco 修改预览，不修改正文；按钮按下状态与两个窗口同步。分窗时两个弹窗共享候选快照，同步导航、预览、保存状态与关闭，不抢焦点。Monaco 使用字符范围红色背景和绿色 injected text 预览，不修改模型、不标记整行。输入后清除过期预览，空闲 350ms 后重算；保留光标、选区与 IME 输入。进入分窗时自动开启 PDF 差异高亮；全部已映射的文字和格式差异默认显示，不受“预览”或选区联动开关影响，仍可通过独立的差异高亮开关关闭。

## 注册接口

```javascript
ReplacementReview.register({
  id: 'format-rule', label: '格式替换',
  provide(context) {
    // 由功能脚本发现候选、校验编辑坐标。
    return [{ id: 'example', options: [{ id: 'fix', label: '修正' }] }];
  },
  content(state, item) {
    return {
      message: item ? '检查本条格式' : '没有候选。',
      options: item?.options || [],
      comparison: [{ label: '说明', parts: [{ text: '由功能脚本生成的内容', changed: false }] }],
      range: item?.range,
      applyLabel: '修正', expanded: false, advance: false
    };
  },
  apply(state, all) {
    // 功能脚本调用编辑器或 toolbox.applyEdits，负责校验、撤销与剩余候选。
    // 返回更新后的 items、choices、position、source、version 等会话字段。
    return state;
  }
});
```

`context.toolbox` 提供 `PdfSelectionDiff` 的文字、字体和编辑工具；源码定位与候选接口使用 `new PdfReviewProvider.PdfLocator()`、`index.reviewCandidates()`。调用前等待 `PdfReviewReady` 完成初始化。`PdfLocator` 管理读取和缓存，每个 `PdfSourceIndex` 保存自己的公开 `source/raw`、坐标和连接；完整类由 `PdfSelectionDiff.PdfSourceIndex` 导出，provider 复用同一类。定位、字体、源码装饰和编辑调用 `index.locate()`、`index.connectionPairs()`、`index.connectionDiff()`、`index.sourceRange()`、`index.connectedRange()`、`index.fontRuns()`、`index.sourceDecorations()`、`index.textEdits()`、`index.fontEdits()` 等实例方法；无实例状态的归一化和搜索工具仍是普通 toolbox 函数，不再经过 locator 包装。

`ReviewHighlights.measureHighlights()` 通过索引的 `fontRuns(start, end, true)` 获取文字节点范围，复用弹窗锚点的坐标查找；`ReviewHighlights.create()` 不再接收 `lowerBound`。公共高亮模块只依赖这个索引接口，不导入 PDF 类。

注册 PDF 审阅时，`locator` 直接提供共享 `PdfLocator` 实例，宿主调用其 `reviewItems(context)`，不经 `provide` 转接。当前 `model/index` 由 locator 持有并随索引读取或重建更新，分组、预览和替换读取同一份实例状态，弹窗 context 不再保存 `index/targets` 副本。`prepareReview()` 统一补齐上下文、登记并更新共享索引。未携带 `source` 时同步返回索引或 `null`，供 `available/isCurrent` 等入口使用；携带 `source` 时继续复用 `indexDocument/indexFonts` 的读取缓存，准备并返回审阅结果。`reviewItems` 保留 `if (context.source !== undefined) return this.prepareReview(context);`，不再有 `checkContext` 或额外布尔模式参数。其他 provider 保持 `provide(context)` 接口。

`provide(context)` 接收 `editor/model/source/version/signal/toolbox/request`，返回候选数组或 `{ items }`。每个候选有唯一字符串 `id`，每个选项有唯一字符串 `id`。首项默认选中，选择保存于 `state.choices`。

`content(state, item)` 定义弹窗内容；没有当前候选时 `item` 为 `undefined`。`comparison` 是行数组，每行包含 `label` 和 `parts: [{ text, changed }]`，由公共弹窗以纯文本渲染。`range` 控制源码选区。`options` 定义显示的单选项；`applyLabel` 定义操作文字；`advance/expanded/all: false` 可隐藏对应操作。`title` 可覆盖注册名称。公共模块不推导 HTML/PDF 对照、替换范围或裁剪方式。

`apply(state, all)` 可以同步或异步返回更新后的会话字段。`state` 包含当前编辑器、模型、原文与版本、候选数组、当前 `position`、选项 `choices` 和发现上下文 `context`。功能脚本负责实际修改、只读与冲突检查，以及候选移除和坐标维护；公共模块只防止重复操作、更新返回的会话、渲染结果或显示错误。`all` 仅表示当前文件全部候选，不批量改写其他文件。

行内预览与展开 diff 共用当前所选方案的 `edits`，装饰缓存和清理由 `ReviewHighlights` 管理；展开 diff 默认通过 `previewEdits` 生成，勾选整个文件时使用全部候选的所选方案。特殊展示仍可提供 `preview(state, wholeFile)`，返回 `{ before, after, language }` 覆盖默认结果。`onSelect(item, context, items, previewEnabled)` 同步当前 PDF 指针；切换预览不触发 PDF 索引准备，默认差异高亮保持独立。

预览开启时，Monaco 灯泡提供当前拟议方案的 quick fix，复用预览的所选 `edits`（包括同组替换），并携带模型版本；应用后可撤销。`ReplacementReview.bindSuggestions(editor, provide)` 接收返回 `{ label, edits }[]` 的同步回调，让差异处的参考建议在弹窗关闭或预览关闭时仍然可用。PDF provider 复用当前索引、候选缓存和 pattern 词边界，保留原始替换方案中的标签位置；缺失 OCR 与格式差异不生成输入补全。仅手动输入、粘贴后自动打开 Monaco 建议列表，移动光标及程序修改不触发；输入法组合期间等待组合结束。单行 pattern 以可接受的补全项显示，接受后替换当前位置的完整 pattern；跨行方案仍通过灯泡或审阅操作处理。两类入口都检查当前模型、只读状态和原文；编辑器释放时注销 provider。验证：`node tests/replacement-suggestions-browser.mjs`。

可选接口保留 `isEnabled/setEnabled/available/isCurrent/onSelect/presentation`。`focusIndex(items, request)` 决定选区请求的候选回退位置，`containsSelection(item, request)` 判断选区是否属于当前候选。仅有 `setEnabled` 的功能注册为独立开关。`ReplacementReview.invalidate(id)` 使外部依赖变化后的会话失效并自动重新计算。

双窗口切回阅读器或编辑器时，以 `document.hasFocus()` 配合窗口 `blur` 判断是否离开窗口：首次点击保留两边弹窗，随后点击其他位置才关闭。弹窗在后台打开或刷新也保留此状态；焦点进入内嵌 iframe 不算切换窗口。键盘开始操作后恢复普通关闭行为，窗口切换用的修饰键及 Alt+Tab 不消耗首次点击保护；关闭按钮始终生效。

## 当前文件前后条

差异命中使用左闭右开的字符范围：点击高亮后方的普通文字不命中前一条差异；空字符差异仍可点击其插入位置。拖选期间不打开弹窗，取消拖选或切出窗口不提交待显示的弹窗。编辑器中按 Escape 关闭弹窗并保留当前选区。

公共弹窗仅在当前文件的候选中移动，到首尾后禁用对应方向；没有候选时禁用前后条。不读取全局文件列表，也不自动打开其他文件。

切换编辑器模型或整体载入文件内容时关闭旧弹窗，不显示旧会话的“重新计算”提示。点击当前高亮差异内或手动修改文本时保留弹窗；点击其他位置关闭弹窗。同一文件内的普通编辑自动更新候选，输入停顿 300 毫秒后计算，输入法组合期间等待组合结束。检测到手动修改后显示保存提醒，按钮改为“保存修改”，仅保存当前内容，不替换下一条；保存成功后恢复“替换&保存”。正常的“替换&保存”先替换当前候选，成功后保存，替换失败时不保存。手动修改仅更新已有候选：删除已修正项、平移其他项坐标，未完全修正时只对该候选重新比较，不重新发现全文件候选。对照 PDF 变化也自动重新计算。PDF 单条替换继续使用当前候选，不重新提取全文，更新剩余候选的源码坐标；与修改冲突的候选移除。

独立 `html_pattern_review/` 页面及其 Python 保存接口保持原有工作流。

验证入口：`node tests/replacement-review-browser.mjs`（编辑器、阅读器、当前文件前后条及边界、换文件关闭弹窗、共享弹窗、PDF 替换及分窗）；`node --test tests/pdf-selection-diff.test.mjs tests/pdf-selection-highlight.test.mjs`（定位与高亮）。浏览器 PDF 差异测试使用受控文字层，不代表整卷扫描 PDF 验证。
