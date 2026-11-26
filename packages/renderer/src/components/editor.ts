/**
 * `<editor>`: an editable rich text area. `EditorContext` drives it through
 * `omrCall`; its content model lives in `editor-model.ts`.
 */
import { fsFileUrl, isFsPath } from "@omr/runtime";
import { toText as stringOf } from "../expression.ts";
import { Builtin, emit } from "./base.ts";
import { warnNewer } from "./store-cards.ts";
import {
  applyFormat,
  clampRange,
  emptyItems,
  formatsAt,
  fromDelta,
  inlineFormats,
  locate,
  readHtml,
  removeFormats,
  replaceRange,
  textItems,
  toDelta,
  toHtml,
  toText,
  type Formats,
  type Item,
  type Value,
} from "./editor-model.ts";

interface Range {
  index: number;
  length: number;
}

interface Snapshot {
  html: string;
  range: Range;
}

/** How many changes `undo` goes back. */
const HISTORY_LIMIT = 100;
/** Typing within this time of the last keystroke is undone together. */
const TYPING_GROUP_MS = 1000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The editing area is light DOM with Quill's class, `ql-editor`, which pages style. */
export class WxEditor extends Builtin {
  private area?: HTMLElement;
  /** The selection the last time it was in the editor; context methods use it after a blur. */
  private range: Range = { index: 0, length: 0 };
  /** Character formats set at a cursor, for the next typed text; null removes one. */
  private pending: Record<string, Value | null> = {};
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastTyping = 0;
  private lastStatus = "";
  /** The size, resize and toolbar controls of a tapped image (`show-img-*`). */
  private imageTools?: HTMLElement;
  private selectedImage?: HTMLImageElement;
  /**
   * Where an image source is shown from. The view sets it to resolve package
   * paths against the caller's template, as `<image>` does.
   */
  omrResolveAsset: (src: string) => string = (src) => (isFsPath(src) ? fsFileUrl(src) : src);

  connectedCallback(): void {
    if (this.area) return;
    const area = document.createElement("div");
    area.className = "ql-editor";
    area.setAttribute("role", "textbox");
    area.setAttribute("aria-multiline", "true");
    area.innerHTML = "<p><br></p>";
    this.area = area;
    this.prepend(area);
    // The page moves up for the simulated keyboard, as WeChat pushes it to keep the editor visible
    const keyboard = (focused: boolean) =>
      document.dispatchEvent(
        new CustomEvent("omr-keyboard", { detail: { input: this, focused, height: 0 } }),
      );
    area.addEventListener("focus", () => {
      keyboard(true);
      emit(this, "focus", this.contents());
    });
    area.addEventListener("blur", () => {
      keyboard(false);
      emit(this, "blur", this.contents());
    });
    area.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof HTMLImageElement && area.contains(target)) this.showImageTools(target);
      else this.hideImageTools();
    });
    area.addEventListener("scroll", () => this.placeImageTools());
    area.addEventListener("beforeinput", (event) => this.beforeInput(event));
    area.addEventListener("input", () => {
      this.hideImageTools();
      this.syncEmpty();
      emit(this, "input", this.contents());
    });
    area.addEventListener("keydown", (event) => {
      if (!(event.ctrlKey || event.metaKey) || area.contentEditable !== "true") return;
      const key = event.key.toLowerCase();
      if (key === "z" || key === "y") {
        event.preventDefault();
        if (key === "y" || event.shiftKey) this.redo();
        else this.undo();
      }
    });
    // Only plain text is pasted
    area.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text) this.insertText(text);
    });
    document.addEventListener("selectionchange", () => this.selectionChanged());
    this.addEventListener("omr-editor-portal", () => this.placePortals());
    this.update();
    this.placePortals();
    setTimeout(() => emit(this, "ready"), 0);
  }

  protected override update(): void {
    const area = this.area;
    if (!area) return;
    area.contentEditable = this.flag("read-only") ? "false" : "true";
    area.dataset.placeholder = this.str("placeholder");
    area.enterKeyHint = this.str("enterkeyhint", "enter");
    this.syncEmpty();
  }

  omrCall(method: string, args: unknown[]): Record<string, unknown> {
    const options = isObject(args[0]) ? args[0] : {};
    switch (method) {
      case "format":
        this.format(stringOf(args[0]), args[1]);
        return {};
      case "removeFormat":
        this.edit((items, range) => ({
          items: removeFormats(items, range.index, range.length),
          range,
        }));
        this.pending = {};
        this.emitStatus(true);
        return {};
      case "insertText":
        this.insertText(stringOf(options.text));
        return {};
      case "insertImage":
        this.insertImage(options);
        return {};
      case "insertCustomBlock": {
        // An empty block of its own line, which an <editor-portal> with this key fills
        const blockId = `block-${(blockCount++).toString(36)}-${Date.now().toString(36)}`;
        this.edit((items, range) => {
          const removed = replaceRange(items, range.index, range.length, []);
          const before = removed[range.index - 1];
          const inserted: Item[] =
            before && before.kind !== "line" && before.kind !== "divider"
              ? [
                  { kind: "line", formats: {} },
                  { kind: "divider", blockId },
                ]
              : [{ kind: "divider", blockId }];
          // Unless nowrap, the cursor goes on to an empty line after the block
          const wrap = !options.nowrap && removed[range.index]?.kind !== "line";
          if (wrap) inserted.push({ kind: "line", formats: {} });
          const next = replaceRange(removed, range.index, 0, inserted);
          const index = range.index + inserted.length - (wrap ? 1 : 0);
          return { items: next, range: { index, length: 0 } };
        });
        return { blockId };
      }
      case "insertDivider":
        this.edit((items, range) => {
          const removed = replaceRange(items, range.index, range.length, []);
          const before = removed[range.index - 1];
          // A divider is a line of its own: the text before the cursor keeps its line
          const inserted: Item[] =
            before && before.kind !== "line" && before.kind !== "divider"
              ? [{ kind: "line", formats: {} }, { kind: "divider" }]
              : [{ kind: "divider" }];
          const next = replaceRange(removed, range.index, 0, inserted);
          return { items: next, range: { index: range.index + inserted.length, length: 0 } };
        });
        return {};
      case "setContents": {
        let items: Item[];
        if (options.delta !== undefined && options.delta !== null) items = fromDelta(options.delta);
        else if (typeof options.html === "string") {
          const template = document.createElement("template");
          template.innerHTML = options.html;
          items = readHtml(template.content).items;
        } else items = emptyItems();
        this.replaceAll(items);
        return {};
      }
      case "clear":
        this.replaceAll(emptyItems());
        return {};
      case "getContents":
        return this.contents();
      case "getSelectionText": {
        // Empty when the editor is not focused, as the documentation says
        if (document.activeElement !== this.area) return { text: "" };
        const { items, selection } = this.read();
        const range = selection ?? this.range;
        return { text: toText(items.slice(range.index, range.index + range.length)) };
      }
      case "undo":
        this.undo();
        return {};
      case "redo":
        this.redo();
        return {};
      case "blur": {
        const selection = document.getSelection();
        if (selection?.anchorNode && this.area!.contains(selection.anchorNode)) {
          selection.removeAllRanges();
        }
        this.area!.blur();
        return {};
      }
      case "scrollIntoView": {
        const { node } = locate(this.area!, this.range.index + this.range.length);
        const element = node instanceof Element ? node : (node as Node).parentElement;
        element?.scrollIntoView({ block: "nearest" });
        return {};
      }
    }
    throw new Error(`${method} is not supported`);
  }

  private format(name: string, value: unknown): void {
    const { items, selection } = this.read();
    const range = clampRange(items, ...rangeArgs(selection ?? this.range));
    const result = applyFormat(items, range.index, range.length, name, value, this.pending);
    this.pending = result.pending;
    if (result.items !== items) {
      this.remember();
      this.render(result.items, range, true);
      emit(this, "input", this.contents());
    } else this.select(range, true);
    this.emitStatus(true);
  }

  private insertText(text: string): void {
    const pending = this.pending;
    this.edit((items, range) => {
      const formats = inlineFormats(formatsAt(items, range.index, 0), pending);
      const inserted = textItems(text, formats);
      return {
        items: replaceRange(items, range.index, range.length, inserted),
        range: { index: range.index + inserted.length, length: 0 },
      };
    });
    this.pending = {};
  }

  private insertImage(options: Record<string, unknown>): void {
    if (typeof options.src !== "string" || options.src === "") {
      throw new Error("parameter error: parameter.src should be String");
    }
    const src = options.src;
    const props: Record<string, string> = {};
    for (const [name, key] of [
      ["alt", "alt"],
      ["width", "width"],
      ["height", "height"],
      ["class", "extClass"],
    ] as const) {
      if (options[key] !== undefined && options[key] !== "") props[name] = stringOf(options[key]);
    }
    if (isObject(options.data)) {
      props["data-custom"] = Object.entries(options.data)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(";");
    }
    // Temporary files are marked, so the page can upload them before it submits the html
    if (isFsPath(src)) props["data-local"] = src;
    this.edit((items, range) => {
      const inserted: Item[] = [{ kind: "image", src, props, formats: {} }];
      if (!options.nowrap) inserted.push({ kind: "line", formats: {} });
      return {
        items: replaceRange(items, range.index, range.length, inserted),
        range: { index: range.index + inserted.length, length: 0 },
      };
    });
  }

  /** `setContents` and `clear`: the cursor goes to the end, and the editor keeps its focus state. */
  private replaceAll(items: Item[]): void {
    this.remember();
    this.pending = {};
    this.render(items, { index: items.length - 1, length: 0 }, false);
    emit(this, "input", this.contents());
  }

  /** Applies a change at the selection and records it for `undo`; context edits focus the editor. */
  private edit(change: (items: Item[], range: Range) => { items: Item[]; range: Range }): void {
    const { items, selection } = this.read();
    const range = clampRange(items, ...rangeArgs(selection ?? this.range));
    const result = change(items, range);
    this.remember();
    this.render(result.items, result.range, true);
    emit(this, "input", this.contents());
  }

  /** The content, and the selection when it is in the editor. */
  private read(): { items: Item[]; selection?: Range } {
    const area = this.area!;
    const selection = document.getSelection();
    const points = [];
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (area.contains(range.startContainer) && area.contains(range.endContainer)) {
        points.push(
          { node: range.startContainer, offset: range.startOffset },
          { node: range.endContainer, offset: range.endOffset },
        );
      }
    }
    const { items, positions } = readHtml(area, points);
    const [start, end] = positions;
    return {
      items,
      selection:
        start === undefined || end === undefined
          ? undefined
          : { index: Math.min(start, end), length: Math.abs(end - start) },
    };
  }

  private render(items: Item[], range: Range, focus: boolean): void {
    this.hideImageTools();
    this.area!.innerHTML = toHtml(items, { imageUrl: (src) => this.omrResolveAsset(src) });
    this.placePortals();
    this.syncEmpty();
    this.select(clampRange(items, range.index, range.length), focus);
  }

  /** Remembers a selection, and shows it when the editor is focused or `focus` asks for it. */
  private select(range: Range, focus: boolean): void {
    const area = this.area!;
    this.range = range;
    if (focus && document.activeElement !== area && area.contentEditable === "true") {
      area.focus({ preventScroll: true });
    }
    if (document.activeElement !== area) return;
    const start = locate(area, range.index);
    const end = locate(area, range.index + range.length);
    const dom = document.createRange();
    dom.setStart(start.node as Node, start.offset);
    dom.setEnd(end.node as Node, end.offset);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(dom);
  }

  private selectionChanged(): void {
    const area = this.area;
    const selection = document.getSelection();
    if (!area || !this.isConnected || !selection?.anchorNode) return;
    if (!area.contains(selection.anchorNode)) return;
    const { selection: range } = this.read();
    if (!range) return;
    if (range.index !== this.range.index || range.length !== this.range.length) {
      this.range = range;
      this.pending = {};
    }
    this.emitStatus(false);
  }

  /** `bindstatuschange`: the formats of the selection, after a context change or when they differ. */
  private emitStatus(force: boolean): void {
    const { items, selection } = this.read();
    const range = selection ?? this.range;
    const formats: Formats = formatsAt(items, range.index, range.length);
    for (const [name, value] of Object.entries(this.pending)) {
      if (value === null) delete formats[name];
      else formats[name] = value;
    }
    const key = JSON.stringify(formats);
    if (!force && key === this.lastStatus) return;
    this.lastStatus = key;
    emit(this, "statuschange", formats);
  }

  private beforeInput(event: InputEvent): void {
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault();
      if (event.inputType === "historyUndo") this.undo();
      else this.redo();
      return;
    }
    if (event.inputType === "insertFromPaste") return;
    // Text typed after a format set at the cursor takes that format
    if (event.inputType === "insertText" && event.data && Object.keys(this.pending).length > 0) {
      event.preventDefault();
      this.insertText(event.data);
      return;
    }
    const now = Date.now();
    if (now - this.lastTyping > TYPING_GROUP_MS) this.remember();
    this.lastTyping = now;
  }

  private remember(): void {
    this.undoStack.push({ html: this.area!.innerHTML, range: { ...this.range } });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private undo(): void {
    this.restore(this.undoStack, this.redoStack);
  }

  private redo(): void {
    this.restore(this.redoStack, this.undoStack);
  }

  private restore(from: Snapshot[], to: Snapshot[]): void {
    const snapshot = from.pop();
    if (!snapshot) return;
    const area = this.area!;
    to.push({ html: area.innerHTML, range: { ...this.range } });
    area.innerHTML = snapshot.html;
    this.lastTyping = 0;
    this.pending = {};
    this.syncEmpty();
    this.select(snapshot.range, false);
    emit(this, "input", this.contents());
  }

  /**
   * Shows the controls `show-img-size` (the image's size), `show-img-resize`
   * (a corner that drags its width) and `show-img-toolbar` (align and delete)
   * ask for around a tapped image.
   */
  private showImageTools(img: HTMLImageElement): void {
    const size = this.flag("show-img-size");
    const resize = this.flag("show-img-resize");
    const toolbar = this.flag("show-img-toolbar") && this.area!.contentEditable === "true";
    if (!size && !resize && !toolbar) return;
    this.hideImageTools();
    this.selectedImage = img;
    const tools = document.createElement("div");
    tools.className = "omr-editor-image-tools";
    tools.contentEditable = "false";
    // The controls keep the editor's focus and selection
    tools.addEventListener("mousedown", (event) => event.preventDefault());
    if (size)
      tools.append(Object.assign(document.createElement("span"), { className: "omr-size" }));
    if (resize && this.area!.contentEditable === "true") {
      const handle = document.createElement("span");
      handle.className = "omr-resize";
      handle.addEventListener("pointerdown", (event) => this.dragImageSize(event, img));
      tools.append(handle);
    }
    if (toolbar) {
      const bar = document.createElement("div");
      bar.className = "omr-toolbar";
      const actions: [string, () => void][] = [
        ["左对齐", () => this.alignImage(img, "left")],
        ["居中", () => this.alignImage(img, "center")],
        ["右对齐", () => this.alignImage(img, "right")],
        ["删除", () => this.deleteImage(img)],
      ];
      for (const [label, run] of actions) {
        const button = document.createElement("span");
        button.textContent = label;
        button.addEventListener("click", run);
        bar.append(button);
      }
      tools.append(bar);
    }
    this.imageTools = tools;
    this.append(tools);
    this.placeImageTools();
  }

  private hideImageTools(): void {
    this.imageTools?.remove();
    this.imageTools = undefined;
    this.selectedImage = undefined;
  }

  /** Puts the controls on the image, which moves when the editor scrolls or the image is resized. */
  private placeImageTools(): void {
    const { imageTools: tools, selectedImage: img } = this;
    if (!tools || !img) return;
    if (!img.isConnected) {
      this.hideImageTools();
      return;
    }
    const host = this.getBoundingClientRect();
    const rect = img.getBoundingClientRect();
    Object.assign(tools.style, {
      left: `${rect.left - host.left}px`,
      top: `${rect.top - host.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    const size = tools.querySelector(".omr-size");
    if (size) size.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
  }

  /** Dragging the corner sets the image's width; its height follows the aspect ratio. */
  private dragImageSize(event: PointerEvent, img: HTMLImageElement): void {
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = img.getBoundingClientRect().width;
    const maxWidth = this.area!.clientWidth;
    this.remember();
    const move = (moved: PointerEvent) => {
      const width = Math.round(
        Math.min(maxWidth, Math.max(20, startWidth + moved.clientX - startX)),
      );
      img.setAttribute("width", String(width));
      img.removeAttribute("height");
      this.placeImageTools();
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      emit(this, "input", this.contents());
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  /** Selects the image, as the toolbar's actions work on it. */
  private selectImage(img: HTMLImageElement): void {
    const range = document.createRange();
    range.selectNode(img);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  private alignImage(img: HTMLImageElement, align: string): void {
    this.selectImage(img);
    this.format("align", align);
  }

  private deleteImage(img: HTMLImageElement): void {
    this.selectImage(img);
    this.edit((items, range) => ({
      items: replaceRange(items, range.index, range.length, []),
      range: { index: range.index, length: 0 },
    }));
  }

  /**
   * Shows each `<editor-portal>` over the custom block of its key, which
   * takes the portal's height; a portal without its block shows nothing.
   */
  private placePortals(): void {
    const area = this.area;
    if (!area) return;
    const blocks = new Map(
      [...area.querySelectorAll<HTMLElement>("[data-block-id]")].map((el) => [
        el.dataset.blockId!,
        el,
      ]),
    );
    let index = 0;
    for (const portal of this.querySelectorAll<WxEditorPortal>("wx-editor-portal")) {
      if (portal.closest("wx-editor") !== this) continue;
      const block = blocks.get(portal.blockKey);
      if (!block) {
        portal.omrAnchor(undefined);
        continue;
      }
      blocks.delete(portal.blockKey);
      const name = `--omr-block-${this.editorId}-${index++}`;
      block.style.setProperty("anchor-name", name);
      portal.omrAnchor(name);
      block.style.height = `${portal.offsetHeight}px`;
      this.portalSizes.observe(portal);
    }
  }
  private readonly editorId = (editorCount++).toString(36);
  /** A portal's content changed size: its block follows. */
  private readonly portalSizes = new ResizeObserver(() => this.placePortals());

  private syncEmpty(): void {
    const area = this.area!;
    area.classList.toggle(
      "ql-blank",
      (area.textContent ?? "") === "" && !area.querySelector("img, hr, [data-block-id]"),
    );
  }

  /** What `getContents` returns, and the detail of focus, blur and input. */
  private contents(): Record<string, unknown> {
    const { items } = this.read();
    return { html: toHtml(items), text: toText(items), delta: toDelta(items) };
  }
}

let editorCount = 0;
let blockCount = 0;

/**
 * `<editor-portal>` (3.7.11): the content of the `<editor>` custom block whose
 * blockId is its `key`. It stays where the template puts it and is shown over
 * the block, anchored to it, so the editor's text never contains it.
 */
export class WxEditorPortal extends Builtin {
  private readonly placement: HTMLStyleElement;
  constructor() {
    super();
    this.placement = this.shadow("<style></style><slot></slot>").querySelector("style")!;
    this.omrAnchor(undefined);
  }
  get blockKey(): string {
    return this.str("key");
  }
  connectedCallback(): void {
    warnNewer("editor-portal", "3.7.11");
    this.changed();
  }
  protected override update(): void {
    this.changed();
  }
  /** Tells the editor around it to place it again. */
  private changed(): void {
    this.dispatchEvent(new CustomEvent("omr-editor-portal", { bubbles: true }));
  }
  /**
   * Shows the portal over the block that has this anchor name, or hides it
   * without one. The name is set inline: anchor names are scoped to the tree
   * that declares them, and the block's is in the document.
   */
  omrAnchor(name: string | undefined): void {
    this.placement.textContent = name
      ? ":host { display: block; position: absolute; top: anchor(top); left: anchor(left); width: anchor-size(width); position-visibility: anchors-visible; }"
      : ":host { display: none; }";
    if (name) this.style.setProperty("position-anchor", name);
    else this.style.removeProperty("position-anchor");
  }
}

const rangeArgs = (range: Range) => [range.index, range.length] as const;
