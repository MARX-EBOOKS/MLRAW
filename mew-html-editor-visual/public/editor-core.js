(() => {
  "use strict";

  class DocumentModel {
    static async load(options) {
      return new DocumentModel({ ...options, ...await options.read() });
    }

    constructor({ text = "", mtime = null, editable = true, read, write } = {}) {
      this.content = text;
      this.savedContent = text;
      this.mtime = mtime;
      this.editable = editable;
      this.revision = 0;
      this.reloadRevision = 0;
      this.read = read;
      this.write = write;
      this.pending = Promise.resolve();
    }

    get dirty() { return this.content !== this.savedContent; }

    textFromEditor(text) {
      const normalize = value => value.replace(/\r\n?/g, "\n");
      for (const source of [this.content, this.savedContent]) {
        if (normalize(source) === normalize(text)) return source;
      }
      return text;
    }

    update(text) {
      if (text !== this.content) this.revision += 1;
      this.content = text;
    }

    enqueue(operation) {
      const task = this.pending.then(operation);
      this.pending = task.catch(() => {});
      return task;
    }

    async writeSnapshot(text) {
      if (!this.editable) throw new Error("Document is read-only");
      const result = await this.write({ text, mtime: this.mtime });
      this.savedContent = text;
      this.mtime = result.mtime;
      return result;
    }

    save(text = this.content) {
      const revision = this.reloadRevision;
      return this.enqueue(() => {
        if (revision !== this.reloadRevision) throw new Error("File reloaded before saving. Review the current content and save again.");
        return this.writeSnapshot(text);
      });
    }

    async saveUntilClean() {
      while (this.dirty) {
        await this.enqueue(() => this.dirty ? this.writeSnapshot(this.content) : undefined);
      }
    }

    refresh() {
      return this.enqueue(async () => {
        const data = await this.read();
        if (data.text === this.savedContent) {
          this.mtime = data.mtime;
          return "unchanged";
        }
        if (data.text === this.content) {
          this.savedContent = data.text;
          this.mtime = data.mtime;
          return "saved";
        }
        if (this.dirty) return "conflict";
        this.reloadRevision += 1;
        this.update(data.text);
        this.savedContent = data.text;
        this.mtime = data.mtime;
        return "updated";
      });
    }
  }

  const registeredColorProviders = new WeakSet();
  const vscodeHtmlThemeRules = dark => {
    const colors = dark ? {
      delimiter: "808080", tag: "7EE787", attribute: "79C0FF", string: "A5D6FF", comment: "8B949E"
    } : {
      delimiter: "800000", tag: "116329", attribute: "0550AE", string: "0A3069", comment: "6E7781"
    };
    return [
      { token: "delimiter.html", foreground: colors.delimiter },
      { token: "tag.html", foreground: colors.tag },
      { token: "attribute.name.html", foreground: colors.attribute },
      { token: "attribute.value.html", foreground: colors.string },
      { token: "comment.html", foreground: colors.comment },
      { token: "comment.content.html", foreground: colors.comment }
    ];
  };

  const vscodeEditorThemeColors = dark => dark ? {
    "focusBorder": "#3994BCB3",
    "input.background": "#191A1B", "input.border": "#333536", "input.foreground": "#BFBFBF", "input.placeholderForeground": "#555555",
    "scrollbar.shadow": "#191B1D4D", "scrollbarSlider.background": "#A8A9AA85", "scrollbarSlider.hoverBackground": "#A8A9AA90", "scrollbarSlider.activeBackground": "#A8A9AA9C",
    "editor.background": "#121314", "editor.foreground": "#BBBEBF", "editorCursor.foreground": "#BBBEBF",
    "editorLineNumber.foreground": "#858889", "editorLineNumber.activeForeground": "#BBBEBF",
    "editor.selectionBackground": "#276782DD", "editor.inactiveSelectionBackground": "#27678260", "editor.selectionHighlightBackground": "#27678260",
    "editor.wordHighlightBackground": "#27678250", "editor.wordHighlightStrongBackground": "#27678280",
    "editor.findMatchBackground": "#27678290", "editor.findMatchHighlightBackground": "#27678280", "editor.findRangeHighlightBackground": "#FFFFFF13",
    "editor.hoverHighlightBackground": "#FFFFFF13", "editor.lineHighlightBackground": "#242526", "editor.rangeHighlightBackground": "#FFFFFF13",
    "editorLink.activeForeground": "#3A94BC", "editorWhitespace.foreground": "#8C8C8C4D",
    "editorIndentGuide.background1": "#8384854D", "editorIndentGuide.activeBackground1": "#838485", "editorRuler.foreground": "#848484", "editorCodeLens.foreground": "#8C8C8C",
    "editorBracketMatch.background": "#3994BC55", "editorBracketMatch.border": "#2A2B2C",
    "editorWidget.background": "#202122", "editorWidget.border": "#2A2B2C", "editorWidget.foreground": "#BFBFBF",
    "editorSuggestWidget.background": "#202122", "editorSuggestWidget.border": "#2A2B2C", "editorSuggestWidget.foreground": "#BFBFBF",
    "editorSuggestWidget.highlightForeground": "#BFBFBF", "editorSuggestWidget.selectedBackground": "#FFFFFF26", "editorSuggestWidget.focusOutline": "#3994BCB3",
    "editorHoverWidget.background": "#202122", "editorHoverWidget.border": "#2A2B2C", "editorGutter.background": "#121314",
    "editorOverviewRuler.border": "#2A2B2C", "editorOverviewRuler.findMatchForeground": "#3A94BC99"
  } : {
    "focusBorder": "#0069CC",
    "input.background": "#FFFFFF", "input.border": "#D8D8D866", "input.foreground": "#202020", "input.placeholderForeground": "#999999",
    "scrollbar.shadow": "#00000000", "scrollbarSlider.background": "#646464C0", "scrollbarSlider.hoverBackground": "#646464D0", "scrollbarSlider.activeBackground": "#646464E0",
    "editor.background": "#FFFFFF", "editor.foreground": "#202020", "editorCursor.foreground": "#202020",
    "editorLineNumber.foreground": "#606060", "editorLineNumber.activeForeground": "#202020",
    "editor.selectionBackground": "#0069CC40", "editor.inactiveSelectionBackground": "#0069CC1A", "editor.selectionHighlightBackground": "#0069CC15",
    "editor.wordHighlightBackground": "#0069CC26", "editor.wordHighlightStrongBackground": "#0069CC26",
    "editor.findMatchBackground": "#0069CC40", "editor.findMatchHighlightBackground": "#0069CC1A", "editor.findRangeHighlightBackground": "#00000015",
    "editor.hoverHighlightBackground": "#00000015", "editor.lineHighlightBackground": "#EAEAEA40", "editor.rangeHighlightBackground": "#00000015",
    "editorLink.activeForeground": "#0069CC", "editorWhitespace.foreground": "#60606040",
    "editorIndentGuide.background1": "#F7F7F740", "editorIndentGuide.activeBackground1": "#EEEEEE", "editorRuler.foreground": "#F7F7F7", "editorCodeLens.foreground": "#606060",
    "editorBracketMatch.background": "#0069CC40", "editorBracketMatch.border": "#F0F1F2",
    "editorWidget.background": "#FAFAFD", "editorWidget.border": "#E4E5E6", "editorWidget.foreground": "#202020",
    "editorSuggestWidget.background": "#FAFAFD", "editorSuggestWidget.border": "#E4E5E6", "editorSuggestWidget.foreground": "#202020",
    "editorSuggestWidget.highlightForeground": "#0069CC", "editorSuggestWidget.selectedBackground": "#00000025", "editorSuggestWidget.selectedForeground": "#202020", "editorSuggestWidget.selectedIconForeground": "#202020", "editorSuggestWidget.focusOutline": "#0069CC",
    "editorHoverWidget.background": "#FAFAFD", "editorHoverWidget.border": "#E4E5E6", "editorGutter.background": "#FFFFFF",
    "editorOverviewRuler.border": "#F0F1F2", "editorOverviewRuler.findMatchForeground": "#0069CC99"
  };
  // 两个入口共用默认配置；仅在确有页面差异时填写下面的覆盖项。
  const monacoOptions = {
    model: null, automaticLayout: true, fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: 14, lineHeight: 21, tabSize: 2, wordWrap: "on", minimap: { enabled: false },
    find: { addExtraSpaceOnTop: false },
    // Monaco 0.55.1 在快速切换模型时可能取消 occurrence 请求并报错。
    occurrencesHighlight: "off", scrollBeyondLastLine: false, padding: { top: 14, bottom: 14 },
    colorDecorators: true, defaultColorDecorators: "never",
    renderLineHighlight: "gutter", renderLineHighlightOnlyWhenFocus: true
  };
  const indexMonacoOptions = {};
  const readerMonacoOptions = {};
  const registeredThemes = new WeakSet();

  function setMonacoTheme(api, dark) {
    if (!registeredThemes.has(api)) {
      for (const isDark of [false, true]) {
        api.editor.defineTheme(isDark ? "mew-dark" : "mew-light", {
          base: isDark ? "vs-dark" : "vs", inherit: true,
          rules: vscodeHtmlThemeRules(isDark), colors: vscodeEditorThemeColors(isDark)
        });
      }
      registeredThemes.add(api);
    }
    api.editor.setTheme(dark ? "mew-dark" : "mew-light");
  }

  function registerHtmlStyleColorProvider(api) {
    if (registeredColorProviders.has(api)) return;
    registeredColorProviders.add(api);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const cssRegions = text => {
      const regions = [];
      for (const match of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
        regions.push({ start: match.index + match[0].indexOf(match[1]), text: match[1] });
      }
      for (const tag of text.matchAll(/<(?!style\b|\/|!)[^>]+>/gi)) {
        for (const attr of tag[0].matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
          regions.push({ start: tag.index + attr.index + attr[0].indexOf(attr[2]), text: attr[2] });
        }
      }
      return regions;
    };
    const parse = value => {
      if (!context || !CSS.supports("color", value)) return null;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "rgba(0, 0, 0, 0)";
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return { red: red / 255, green: green / 255, blue: blue / 255, alpha: alpha / 255 };
    };
    const colorPattern = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b|(?:rgba?|hsla?)\([^)]*\)/gi;
    api.languages.registerColorProvider("html", {
      provideDocumentColors(model) {
        const colors = [];
        for (const region of cssRegions(model.getValue())) {
          for (const match of region.text.matchAll(colorPattern)) {
            const color = parse(match[0]);
            if (!color) continue;
            const start = region.start + match.index;
            colors.push({ color, range: api.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(start + match[0].length)) });
          }
        }
        return colors;
      },
      provideColorPresentations(_model, { color, range }) {
        const bytes = [color.red, color.green, color.blue, color.alpha].map(value => Math.round(value * 255));
        const hex = bytes.slice(0, bytes[3] === 255 ? 3 : 4).map(value => value.toString(16).padStart(2, "0")).join("");
        const label = `#${hex}`;
        return [{ label, textEdit: { range, text: label } }];
      }
    });
  }

  class MonacoController {
    constructor(api, host, { page = "index", scale = 1, dark = false, ...options } = {}) {
      this.api = api;
      registerHtmlStyleColorProvider(api);
      setMonacoTheme(api, dark);
      const config = { ...monacoOptions, ...(page === "reader" ? readerMonacoOptions : indexMonacoOptions), ...options };
      this.fontSize = config.fontSize;
      this.lineHeight = config.lineHeight;
      this.editor = api.editor.create(host, {
        ...config, fontSize: this.fontSize * scale, lineHeight: Math.round(this.lineHeight * scale)
      });
    }

    createModel({ text = "", language = "html", uri, onChange } = {}) {
      const model = this.api.editor.createModel(text, language, uri);
      if (onChange) model.onDidChangeContent(() => onChange(model));
      return model;
    }

    get model() { return this.editor.getModel(); }
    getValue() { return this.model?.getValue() || ""; }
    setModel(model) { this.editor.setModel(model); }
    focus() { this.editor.focus(); }
    hasTextFocus() { return this.editor.hasTextFocus(); }
    setEditable(editable) { this.editor.updateOptions({ readOnly: !editable }); }
    setScale(scale) {
      this.editor.updateOptions({ fontSize: this.fontSize * scale, lineHeight: Math.round(this.lineHeight * scale) });
    }
    selection() {
      const selection = this.editor.getSelection(), model = this.model;
      return selection && model ? { start: model.getOffsetAt(selection.getStartPosition()), end: model.getOffsetAt(selection.getEndPosition()) } : { start: 0, end: 0 };
    }
    selections() {
      return (this.editor.getSelections() || []).map(selection => ({
        start: this.model.getOffsetAt(selection.getStartPosition()),
        end: this.model.getOffsetAt(selection.getEndPosition())
      }));
    }
    replaceRanges(edits, selections, origin) {
      const model = this.model;
      this.editor.pushUndoStop();
      this.editor.executeEdits(origin, edits.map(edit => ({
        range: this.api.Range.fromPositions(model.getPositionAt(edit.start), model.getPositionAt(edit.end)),
        text: edit.text, forceMoveMarkers: true
      })), () => selections.map(selection => this.api.Selection.fromPositions(
        model.getPositionAt(selection.start), model.getPositionAt(selection.end))));
      this.editor.pushUndoStop();
    }
    setSelection(start, end = start) {
      this.editor.setSelection(this.api.Selection.fromPositions(this.model.getPositionAt(start), this.model.getPositionAt(end)));
    }
    replaceRange(text, start, end, selectStart = start, selectEnd = selectStart, origin = "mew.edit") {
      const model = this.model;
      if (!model) return;
      const range = this.api.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end));
      this.editor.pushUndoStop();
      this.editor.executeEdits(origin, [{ range, text, forceMoveMarkers: true }], () => [
        this.api.Selection.fromPositions(model.getPositionAt(selectStart), model.getPositionAt(selectEnd))
      ]);
      this.editor.pushUndoStop();
    }
    setValue(text, preserveUndo = false, origin = "mew.setValue") {
      text = String(text ?? "");
      if (!this.model || this.getValue() === text) return;
      if (!preserveUndo) return this.model.setValue(text);
      const range = this.model.getFullModelRange();
      this.editor.pushUndoStop();
      this.editor.executeEdits(origin, [{ range, text, forceMoveMarkers: true }]);
      this.editor.pushUndoStop();
    }
    undo() { this.editor.trigger("mew", "undo"); this.focus(); }
    redo() { this.editor.trigger("mew", "redo"); this.focus(); }
    canUndo() { return Boolean(this.model?.canUndo()); }
    canRedo() { return Boolean(this.model?.canRedo()); }
    async toggleFind({ replace = true, toggleIfVisible = true, readClipboard = false } = {}) {
      const visible = this.editor.getDomNode()?.querySelector(".find-widget")?.classList.contains("visible");
      if (visible && toggleIfVisible) return this.editor.trigger("mew", "closeFindWidget");
      const clipboard = readClipboard && !visible && navigator.clipboard?.readText?.().catch(() => null);
      if (!visible) this.focus();
      await this.editor.getAction(replace ? "editor.action.startFindReplaceAction" : "actions.find")?.run();
      const text = await clipboard;
      if (text) this.editor.getContribution("editor.contrib.findController")?.setSearchString(text.replace(/\r\n?/g, "\n"));
    }
  }

  function languageForPath(api, path) {
    const name = String(path).replaceAll("\\", "/").split("/").pop().toLowerCase();
    const languages = api.languages.getLanguages();
    const named = languages.find(language => language.filenames?.some(filename => filename.toLowerCase() === name));
    if (named) return named.id;
    let match = null;
    for (const language of languages) {
      for (const extension of language.extensions || []) {
        const suffix = extension.toLowerCase();
        if (name.endsWith(suffix) && (!match || suffix.length > match.suffix.length)) match = { id: language.id, suffix };
      }
    }
    return match?.id || "plaintext";
  }

  function createChannel(session, receive) {
    const name = `mew-reader-${session}`;
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel(name);
      channel.onmessage = event => receive(event.data);
      return channel;
    }
    const key = `__${name}`;
    const listener = event => {
      if (event.key !== key || !event.newValue) return;
      try { receive(JSON.parse(event.newValue).message); } catch { /* ignore malformed peer data */ }
    };
    window.addEventListener("storage", listener);
    return {
      postMessage(message) { localStorage.setItem(key, JSON.stringify({ nonce: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, message })); },
      close() { window.removeEventListener("storage", listener); }
    };
  }

  function loadMonaco(path = "/monaco/min/vs") {
    if (typeof require !== "function") return Promise.reject(new Error("Monaco 加载器未载入"));
    require.config({ paths: { vs: path } });
    return new Promise((resolve, reject) => require(["vs/editor/editor.main"], resolve, reject));
  }

  window.MewEditorCore = { DocumentModel, MonacoController, createChannel, languageForPath, loadMonaco, setMonacoTheme };
})();
