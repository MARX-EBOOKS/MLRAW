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
    constructor(api, host, options = {}) {
      this.api = api;
      registerHtmlStyleColorProvider(api);
      this.editor = api.editor.create(host, options);
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
    setScale(scale, lineHeight = 21) {
      this.editor.updateOptions({ fontSize: 14 * scale, lineHeight: Math.round(lineHeight * scale) });
    }
    selection() {
      const selection = this.editor.getSelection(), model = this.model;
      return selection && model ? { start: model.getOffsetAt(selection.getStartPosition()), end: model.getOffsetAt(selection.getEndPosition()) } : { start: 0, end: 0 };
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

  window.MewEditorCore = { DocumentModel, MonacoController, createChannel, languageForPath, loadMonaco };
})();
