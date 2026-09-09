(() => {
  "use strict";

  const tags = [
    { id: "b", label: "B", shortcut: "b", open: "<b>", close: "</b>", title: "Alt+B / b" },
    { id: "i", label: "I", shortcut: "i", open: "<i>", close: "</i>", title: "Alt+I / i" },
    { id: "em", label: "EM", shortcut: "em", open: "<em>", close: "</em>", title: "Insert emphasis" },
    { id: "q", label: "Q", shortcut: "q", open: "<blockquote>", close: "</blockquote>", title: "Alt+Q / q" },
    { id: "a", label: "A", shortcut: "a", open: "<a href=\"\" id=\"\">", close: "</a>", title: "Alt+A / a" },
    { id: "x", label: "AID", shortcut: "x", open: "<a id=\"\">", close: "</a>", title: "Alt+X / x" },
    { id: "l", label: "HREF", shortcut: "l", open: "<a href=\"\">", close: "</a>", title: "Alt+L / l" },
    { id: "f", label: "FN", shortcut: "f", open: "<sup><a href=\"\" id=\"\">", close: "</a></sup>", title: "Alt+F / f" },
    { id: "r", label: "R", shortcut: "r", open: "<p align=\"right\">", close: "</p>", title: "Alt+R / r" },
    { id: "c", label: "C", shortcut: "c", open: "<p align=\"center\">", close: "</p>", title: "Alt+C / c" },
    { id: "ltgt", label: "&lt;&gt;", shortcut: "&lt;&gt;", open: "&lt;", close: "&gt;", title: "Insert angle bracket" },
    ...Array.from({ length: 6 }, (_, index) => {
      const shortcut = String(index + 1), id = `h${shortcut}`;
      return { id, label: id.toUpperCase(), shortcut, open: `<${id}>`, close: `</${id}>`, title: `Alt+${shortcut} / ${shortcut}` };
    }),
    { id: "p", label: "P", shortcut: "p", open: "<p>", close: "</p>", title: "Alt+P / p" },
    { id: "div", label: "DIV", shortcut: "d", open: "<div>", close: "</div>", title: "Alt+D / d" },
    { id: "span", label: "SPAN", shortcut: "s", open: "<span>", close: "</span>", title: "Alt+S / s" },
    { id: "aside", label: "ASIDE", shortcut: "aside", open: "<aside>", close: "</aside>", title: "Aside" },
    { id: "sup", label: "SUP", shortcut: "sup", open: "<sup>", close: "</sup>", title: "Insert Superscript" },
    { id: "sub", label: "SUB", shortcut: "sub", open: "<sub>", close: "</sub>", title: "Insert Subscript" }
  ];
  const attrs = [
    { id: "idAttr", label: "ID=", text: " id=\"\"", cursorOffset: 5, title: "Insert id attribute" },
    { id: "classAttr", label: "CLASS=", text: " class=\"\"", cursorOffset: 8, title: "Insert class attribute" },
    { id: "styleAttr", label: "STYLE=", text: " style=\"\"", cursorOffset: 8, title: "Insert style attribute" },
    { id: "hrs", label: "HRS", text: "<hr style=\"width: 20%;\">", cursorOffset: 22, title: "Insert short hardline" },
    { id: "noIndentAttr", label: "NO INDENT", text: " style=\"text-indent: 0;\"", cursorOffset: 23, title: "Insert no-indent style attribute" },
    { id: "HR", label: "HR", text: "<hr>", cursorOffset: 3, title: "Insert hardline" },
    { id: "BR", label: "BR", text: "<br>", cursorOffset: 3, title: "Insert change line" }
  ];
  const tagMap = new Map(tags.filter(tag => tag.shortcut).map(tag => [tag.shortcut.toLowerCase(), tag]));
  const blockTagNames = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6"]);
  const blockTagIds = new Set(["p", "r", "c", "h1", "h2", "h3", "h4", "h5", "h6", "div"]);
  const voidTagNames = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const rawTagNames = new Set(["script", "style", "textarea", "title"]);
  const tagPattern = /<!--[\s\S]*?-->|<\/?[A-Za-z][\w:-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;

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

  function changeWrapper(text, element, start, end, tag) {
    const open = tag?.open || "", close = tag?.close || "";
    const inner = text.slice(element.openEnd, element.closeStart);
    const whole = start === element.start && end === element.end;
    const inOpeningTag = start === end && element.start < start && start < element.openEnd;
    const from = whole || inOpeningTag ? 0 : start - element.openEnd;
    const to = whole ? inner.length : inOpeningTag ? 0 : end - element.openEnd;
    return { start: element.start, end: element.end, text: open + inner + close,
      selectStart: open.length + from, selectEnd: open.length + to };
  }

  function wrapEdit(start, end, selected, tag, keepSelection) {
    const text = tag.open + selected + tag.close;
    const emptyAttribute = tag.open.indexOf('=""');
    const cursor = emptyAttribute >= 0 ? emptyAttribute + 2 : selected ? text.length : tag.open.length;
    return { start, end, text,
      selectStart: keepSelection ? tag.open.length : cursor,
      selectEnd: keepSelection ? tag.open.length + selected.length : cursor };
  }

  function tagPairs(text) {
    const stack = [], pairs = [];
    let rawName;
    tagPattern.lastIndex = 0;
    for (let match; (match = tagPattern.exec(text));) {
      const token = match[0];
      if (token.startsWith("<!--")) continue;
      const name = token.match(/^<\/?([A-Za-z][\w:-]*)/i)[1].toLowerCase();
      const closing = /^<\//.test(token);
      if (rawName && !(closing && name === rawName)) continue;
      if (closing) {
        const open = stack.at(-1);
        const crossed = stack.findLastIndex(item => item.name === name);
        if (open && (open.name === name || crossed < 0)) {
          stack.pop();
          pairs.push({ name: open.name, closeName: name, start: open.start, openEnd: open.end,
            closeStart: match.index, end: tagPattern.lastIndex, open: open.token });
          if (name === rawName) rawName = undefined;
        } else if (crossed >= 0) stack.length = crossed;
      } else if (voidTagNames.has(name) || /\/\s*>$/.test(token)) {
        pairs.push({ name, start: match.index, openEnd: tagPattern.lastIndex,
          closeStart: tagPattern.lastIndex, end: tagPattern.lastIndex, open: token });
      } else {
        stack.push({ name, start: match.index, end: tagPattern.lastIndex, token });
        if (rawTagNames.has(name)) rawName = name;
      }
    }
    return pairs;
  }

  function innermost(elements, start, end) {
    return elements
      .filter(element => (start === end && element.start < start && start < element.openEnd) ||
        (element.openEnd <= start && end <= element.closeStart))
      .reduce((inner, element) => !inner || element.end - element.start < inner.end - inner.start ? element : inner, undefined);
  }

  function isCompleteSelection(text, elements, start, end) {
    const byStart = new Map(elements.map(element => [element.start, element]));
    let cursor = start, found = false;
    while (cursor < end) {
      if (/\s/.test(text[cursor])) { cursor += 1; continue; }
      const outer = byStart.get(cursor);
      if (!outer || outer.end > end) return false;
      found = true;
      cursor = outer.end;
    }
    return found;
  }

  function blockId(element) {
    if (element.name !== "p") return element.name;
    const align = element.open.match(/\balign\s*=\s*["']?(center|right)/i)?.[1]?.toLowerCase();
    return align === "center" ? "c" : align === "right" ? "r" : "p";
  }

  function buildTagEdit(text, start, end, tag) {
    const elements = tagPairs(text);
    const selected = text.slice(start, end);
    const name = /^<([A-Za-z][\w:-]*)\b/.exec(tag.open)?.[1].toLowerCase();
    const simple = name && tag.close.toLowerCase() === `</${name}>`;
    const complete = start < end && isCompleteSelection(text, elements, start, end);
    const exact = complete && elements.find(element => element.start === start && element.end === end);
    if (complete) {
      if (exact && exact.closeName && exact.closeName !== exact.name) {
        return changeWrapper(text, exact, start, end, name === exact.name ? undefined : tag);
      }
      if (exact && blockTagNames.has(exact.name) && blockTagIds.has(tag.id)) {
        if (blockId(exact) === tag.id) return changeWrapper(text, exact, start, end);
        if (tag.id !== "div") return changeWrapper(text, exact, start, end, tag);
      }
      if (exact && exact.name === name && simple) return changeWrapper(text, exact, start, end);
      if (tag.close && selected.startsWith(tag.open) && selected.endsWith(tag.close)) {
        const inner = selected.slice(tag.open.length, -tag.close.length);
        return { start, end, text: inner, selectStart: 0, selectEnd: inner.length };
      }
      return wrapEdit(start, end, selected, tag, true);
    }
    const block = blockTagIds.has(tag.id) && innermost(elements.filter(element => blockTagNames.has(element.name)), start, end);
    if (block) return changeWrapper(text, block, start, end, blockId(block) === tag.id ? undefined : tag);
    const same = simple && innermost(elements.filter(element => element.name === name), start, end);
    if (same) return changeWrapper(text, same, start, end);
    const before = start - tag.open.length, after = end + tag.close.length;
    if (tag.close && before >= 0 && text.slice(before, start) === tag.open && text.slice(end, after) === tag.close) {
      return { start: before, end: after, text: selected, selectStart: 0, selectEnd: selected.length };
    }
    return wrapEdit(start, end, selected, tag, false);
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
    applyTag(tag) {
      const { start, end } = this.selection();
      const operation = buildTagEdit(this.getValue(), start, end, tag);
      this.replaceRange(operation.text, operation.start, operation.end,
        operation.start + operation.selectStart, operation.start + operation.selectEnd, "mew.tag");
      this.editor.revealRangeInCenterIfOutsideViewport(this.editor.getSelection());
      this.focus();
      return operation;
    }
    insert(attr) {
      const { start, end } = this.selection();
      const cursor = start + (attr.cursorOffset ?? attr.text.length);
      this.replaceRange(attr.text, start, end, cursor, cursor, "mew.attr");
      this.focus();
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

  window.MewEditorCore = {
    DocumentModel, MonacoController, tags, attrs, tagMap, blockTagNames,
    buildTagEdit, createChannel, languageForPath, loadMonaco
  };
})();
