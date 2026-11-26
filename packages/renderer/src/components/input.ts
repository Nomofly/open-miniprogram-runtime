/** `<input>` and `<textarea>`; their parts are light DOM so `placeholder-class` can use the page's styles. */
import { toText } from "../expression.ts";
import { Applied, Builtin, emit } from "./base.ts";
import { filterInputValue } from "./format.ts";

export class WxInput extends Builtin {
  protected field?: HTMLInputElement | HTMLTextAreaElement;
  private placeholder?: HTMLElement;
  private readonly applied = new Applied();
  /** The value when the field got focus, for `change` on blur. */
  private focusValue = "";
  protected readonly defaultPlaceholderClass: string = "input-placeholder";
  protected createField(): HTMLInputElement | HTMLTextAreaElement {
    return document.createElement("input");
  }
  connectedCallback(): void {
    if (this.field) return;
    this.placeholder = document.createElement("div");
    this.field = this.createField();
    // Before any children, so the view's patching does not move them
    this.prepend(this.placeholder, this.field);
    const field = this.field;
    field.addEventListener("input", () => {
      const filtered = this.filter(field.value);
      if (filtered !== field.value) {
        const cursor =
          (field.selectionStart ?? filtered.length) - (field.value.length - filtered.length);
        field.value = filtered;
        field.setSelectionRange(Math.max(0, cursor), Math.max(0, cursor));
      }
      this.syncPlaceholder();
      this.onInput();
      emit(this, "input", { value: field.value, cursor: field.selectionStart ?? 0, keyCode: 0 });
    });
    field.addEventListener("focus", () => {
      this.focusValue = field.value;
      emit(this, "focus", { value: field.value, height: 0 });
      if (this.isNickname()) this.announceNicknameFocus(true);
    });
    field.addEventListener("blur", () => {
      emit(this, "blur", { value: field.value, cursor: field.selectionStart ?? 0 });
      if (field.value !== this.focusValue) emit(this, "change", { value: field.value });
      if (!this.isNickname()) return;
      this.announceNicknameFocus(false);
      // WeChat reviews the nickname asynchronously after blur; the simulator passes every nickname
      if (field.value !== "") {
        setTimeout(() => emit(this, "nicknamereview", { pass: true, timeout: false }), 200);
      }
    });
    field.addEventListener("keydown", (raw) => {
      const event = raw as KeyboardEvent;
      if (event.key !== "Enter" || !this.confirmsOnEnter(event)) return;
      event.preventDefault();
      emit(this, "confirm", { value: field.value });
      // The keyboard closes unless confirm-hold asks to keep it
      if (!this.flag("confirm-hold")) field.blur();
    });
    this.update();
  }
  protected confirmsOnEnter(_event: KeyboardEvent): boolean {
    return true;
  }
  protected onInput(): void {}
  private filter(value: string): string {
    return this.field instanceof HTMLInputElement
      ? filterInputValue(this.str("type", "text"), value)
      : value;
  }
  protected override update(): void {
    const { field, placeholder } = this;
    if (!field || !placeholder) return;
    // Only a changed value property replaces what the user typed
    if (this.applied.changed("value", this.props.value)) field.value = toText(this.props.value);
    if (field instanceof HTMLInputElement) {
      const type = this.str("type", "text");
      field.type = this.flag("password") || type === "safe-password" ? "password" : "text";
      field.inputMode =
        type === "number"
          ? "numeric"
          : type === "digit"
            ? "decimal"
            : type === "idcard"
              ? "text"
              : "";
    }
    field.enterKeyHint = this.keyHint();
    const maxlength = this.num("maxlength", 140);
    if (maxlength < 0) field.removeAttribute("maxlength");
    else field.maxLength = maxlength;
    field.disabled = this.flag("disabled");
    // `cursor-color`: a color on iOS; Android knows only "default" and "green"
    const cursor = this.str("cursor-color");
    field.style.caretColor = cursor === "green" ? "#07c160" : cursor === "default" ? "" : cursor;
    placeholder.textContent = this.str("placeholder");
    placeholder.className =
      `omr-placeholder ${this.str("placeholder-class") || this.defaultPlaceholderClass}`.trim();
    placeholder.setAttribute("style", this.str("placeholder-style"));
    this.syncPlaceholder();
    // Focus follows focus and auto-focus only when they change, so other renders keep the user's focus
    const focusChanged = this.applied.changed("focus", this.flag("focus"));
    const autoChanged = this.applied.changed("auto-focus", this.flag("auto-focus"));
    if ((focusChanged || autoChanged) && !field.disabled) {
      if (this.flag("focus") || this.flag("auto-focus")) queueMicrotask(() => this.focusField());
      else if (focusChanged && document.activeElement === field) field.blur();
    } else if (document.activeElement === field) {
      this.applySelection(false);
    }
  }
  protected keyHint(): string {
    return this.str("confirm-type", "done");
  }
  private focusField(): void {
    const field = this.field;
    if (!field || !this.isConnected) return;
    field.focus();
    this.applySelection(true);
  }
  /** Puts the cursor where `cursor` or `selection-start`/`selection-end` say; on focus, or when they change. */
  private applySelection(focusing: boolean): void {
    const field = this.field!;
    const length = field.value.length;
    const start = this.num("selection-start", -1);
    const end = this.num("selection-end", -1);
    const cursor = this.num("cursor", -1);
    const selectionChanged = [
      this.applied.changed("selection-start", start),
      this.applied.changed("selection-end", end),
    ].includes(true);
    const cursorChanged = this.applied.changed("cursor", cursor);
    if (start >= 0 && end >= 0 && (focusing || selectionChanged)) {
      field.setSelectionRange(Math.min(start, length), Math.min(end, length));
    } else if (cursor >= 0 && (focusing || cursorChanged)) {
      field.setSelectionRange(Math.min(cursor, length), Math.min(cursor, length));
    }
  }
  private isNickname(): boolean {
    return this.field instanceof HTMLInputElement && this.str("type") === "nickname";
  }
  private announceNicknameFocus(focused: boolean): void {
    document.dispatchEvent(new CustomEvent("omr-nickname", { detail: { focused, input: this } }));
  }
  omrFill(value: string): void {
    if (!this.field) return;
    this.field.value = value;
    this.syncPlaceholder();
    emit(this, "input", { value, cursor: value.length, keyCode: 0 });
  }
  private syncPlaceholder(): void {
    if (this.placeholder && this.field) this.placeholder.hidden = this.field.value !== "";
  }
  omrFormValue(): unknown {
    return this.field?.value ?? "";
  }
  omrReplaceValue(value: string): void {
    const field = this.field;
    if (!field) return;
    const maxlength = this.num("maxlength", 140);
    field.value = maxlength >= 0 ? value.slice(0, maxlength) : value;
    if (document.activeElement === field) {
      field.setSelectionRange(field.value.length, field.value.length);
    }
    this.syncPlaceholder();
    this.onInput();
  }
  omrReset(): void {
    if (this.field) this.field.value = "";
    this.syncPlaceholder();
  }
}

export class WxTextarea extends WxInput {
  protected override readonly defaultPlaceholderClass = "textarea-placeholder";
  private lineCount = 0;
  protected override createField(): HTMLTextAreaElement {
    return document.createElement("textarea");
  }
  protected override update(): void {
    super.update();
    this.fitHeight();
  }
  protected override onInput(): void {
    this.fitHeight();
  }
  protected override keyHint(): string {
    return this.str("confirm-type", "return") === "return" ? "enter" : this.str("confirm-type");
  }
  /** Enter adds a line, unless `confirm-type` names a button other than return. */
  protected override confirmsOnEnter(event: KeyboardEvent): boolean {
    const type = this.str("confirm-type", "return");
    return type !== "return" && !event.shiftKey;
  }
  private fitHeight(): void {
    const field = this.field;
    if (!field) return;
    // At no height, the scroll height is the height of the text
    field.style.height = "0px";
    const contentHeight = field.scrollHeight;
    field.style.height = this.flag("auto-height") ? `${contentHeight}px` : "";
    const lineHeight = Number.parseFloat(getComputedStyle(field).lineHeight) || 20;
    const lineCount = Math.max(1, Math.round(contentHeight / lineHeight));
    if (lineCount === this.lineCount) return;
    const first = this.lineCount === 0;
    this.lineCount = lineCount;
    if (first) return;
    const height = Math.round(lineCount * lineHeight);
    emit(this, "linechange", {
      height,
      heightRpx: Math.round((height * 750) / window.innerWidth),
      lineCount,
    });
  }
}
