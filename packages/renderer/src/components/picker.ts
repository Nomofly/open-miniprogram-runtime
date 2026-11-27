/** `<picker>`: a sheet of wheels that rises from the bottom of the page. */
import { toText } from "../expression.ts";
import { Applied, Builtin, emit } from "./base.ts";
import {
  dateColumns,
  formatDate,
  formatTime,
  timeColumns,
  type DateFields,
} from "./date-columns.ts";
import {
  regionColumns,
  regionDepth,
  regionPathOf,
  regionResult,
  streetsLoading,
} from "./region.ts";
import { Wheel } from "./wheel.ts";

const ROW_HEIGHT = 48;
const VISIBLE_ROWS = 5;
const SHEET_DURATION = 300;

/** What the sheet shows for one mode, and the `change` detail it confirms. */
interface Model {
  columns: string[][];
  selected: number[];
  select(column: number, index: number): void;
  detail(): Record<string, unknown>;
  /** Whether the selection is still loading, as a district's streets do; confirming waits. */
  loading?(): boolean;
}

interface SheetHandlers {
  select(column: number, index: number): void;
  cancel(): void;
  confirm(): void;
}

/** The sheet: a header with 取消, the title and 确定, above one wheel per column. */
class PickerSheet {
  private readonly mask = document.createElement("div");
  private readonly sheet = document.createElement("div");
  private readonly body = document.createElement("div");
  private wheels: { column: HTMLElement; content: HTMLElement; wheel: Wheel; labels: string }[] =
    [];
  private closed = false;

  private readonly handlers: SheetHandlers;

  constructor(title: string, handlers: SheetHandlers) {
    this.handlers = handlers;
    this.mask.className = "omr-picker-mask";
    this.sheet.className = "omr-picker";
    const header = document.createElement("div");
    header.className = "omr-picker-header";
    // Labels as WeChat shows them
    const cancel = Object.assign(document.createElement("span"), { textContent: "取消" });
    cancel.className = "omr-picker-cancel";
    const heading = Object.assign(document.createElement("span"), { textContent: title });
    heading.className = "omr-picker-title";
    const confirm = Object.assign(document.createElement("span"), { textContent: "确定" });
    confirm.className = "omr-picker-confirm";
    header.append(cancel, heading, confirm);
    this.body.className = "omr-picker-body";
    this.body.style.height = `${ROW_HEIGHT * VISIBLE_ROWS}px`;
    const highlight = document.createElement("div");
    highlight.className = "omr-picker-highlight";
    const fade = document.createElement("div");
    fade.className = "omr-picker-fade";
    this.body.append(highlight, fade);
    this.sheet.append(header, this.body);
    cancel.addEventListener("click", () => handlers.cancel());
    this.mask.addEventListener("click", () => handlers.cancel());
    confirm.addEventListener("click", () => handlers.confirm());
    document.body.append(this.mask, this.sheet);
    // In the top layer, so it opens over a root-portal it may sit in
    for (const layer of [this.mask, this.sheet]) {
      layer.popover = "manual";
      layer.showPopover();
    }
    // Slide in on the next frame, once the closed position has been laid out
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (this.closed) return;
        this.mask.classList.add("omr-open");
        this.sheet.classList.add("omr-open");
      }),
    );
  }

  /** Shows the columns; a column whose items did not change keeps its wheel. */
  show(columns: string[][], selected: number[]): void {
    while (this.wheels.length > columns.length) this.wheels.pop()!.column.remove();
    columns.forEach((labels, index) => {
      let entry = this.wheels[index];
      if (!entry) {
        const column = document.createElement("div");
        column.className = "omr-picker-column";
        const content = document.createElement("div");
        content.className = "omr-picker-content";
        column.append(content);
        this.body.insertBefore(column, this.body.lastElementChild);
        const wheel = new Wheel(column, content, {
          release: (row) => this.handlers.select(index, row),
          settle: () => {},
        });
        entry = { column, content, wheel, labels: "" };
        this.wheels.push(entry);
      }
      const key = JSON.stringify(labels);
      if (entry.labels !== key) {
        entry.labels = key;
        entry.content.replaceChildren(
          ...labels.map((label) => {
            const option = document.createElement("div");
            option.className = "omr-picker-option";
            option.textContent = label;
            return option;
          }),
        );
      }
      entry.wheel.layout(ROW_HEIGHT, labels.length, ROW_HEIGHT * VISIBLE_ROWS);
      entry.wheel.setIndex(selected[index] ?? 0);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.mask.classList.remove("omr-open");
    this.sheet.classList.remove("omr-open");
    setTimeout(() => {
      this.mask.remove();
      this.sheet.remove();
    }, SHEET_DURATION);
  }
}

export class WxPicker extends Builtin {
  private sheet?: PickerSheet;
  private model?: Model;
  private readonly applied = new Applied();
  /** The value the picker holds for a form: its `value`, until the user confirms another. */
  private value: unknown;

  protected override update(): void {
    const valueChanged = this.applied.changed("value", this.props.value);
    if (valueChanged) this.value = this.props.value;
    const rangeChanged = this.applied.changed("range", this.props.range);
    // A multi-column picker follows `range` and `value` while it is open, for cascading columns
    if (
      this.sheet &&
      this.model &&
      this.str("mode") === "multiSelector" &&
      (rangeChanged || valueChanged)
    ) {
      const next = this.multiModel(valueChanged ? undefined : this.model.selected);
      this.model = next;
      this.sheet.show(next.columns, next.selected);
    }
  }

  omrActivate(): void {
    if (this.flag("disabled") || this.sheet) return;
    const model = this.createModel();
    if (!model) {
      console.warn(`[omr] picker mode "${this.str("mode")}" is not supported in the simulator`);
      emit(this, "cancel");
      return;
    }
    this.model = model;
    const sheet = new PickerSheet(this.str("header-text"), {
      select: (column, index) => {
        const current = this.model;
        if (!current || current.selected[column] === index) return;
        current.select(column, index);
        sheet.show(current.columns, current.selected);
      },
      cancel: () => {
        this.close();
        emit(this, "cancel");
      },
      confirm: () => {
        if (this.model!.loading?.()) return;
        const detail = this.model!.detail();
        this.close();
        this.value = detail.value;
        emit(this, "change", detail);
      },
    });
    this.sheet = sheet;
    sheet.show(model.columns, model.selected);
  }

  disconnectedCallback(): void {
    this.close();
  }

  private close(): void {
    this.sheet?.close();
    this.sheet = undefined;
    this.model = undefined;
  }

  /** Without a `value`, a form gets the mode's default: the first option, or nothing chosen. */
  omrFormValue(): unknown {
    return this.value ?? this.defaultValue();
  }
  omrReset(): void {
    this.value = undefined;
  }
  private defaultValue(): unknown {
    switch (this.str("mode", "selector")) {
      case "selector":
        return 0;
      case "multiSelector":
        return Array.isArray(this.props.range) ? this.props.range.map(() => 0) : [];
      case "region":
        return [];
      default:
        return "";
    }
  }

  private label(item: unknown): string {
    const key = this.str("range-key");
    const value =
      key && item && typeof item === "object" ? (item as Record<string, unknown>)[key] : item;
    return toText(value);
  }

  private createModel(): Model | undefined {
    switch (this.str("mode", "selector")) {
      case "selector":
      case "":
        return this.selectorModel();
      case "multiSelector":
        return this.multiModel();
      case "date":
        return this.dateModel();
      case "time":
        return this.timeModel();
      case "region":
        return this.regionModel();
      default:
        return undefined;
    }
  }

  private selectorModel(): Model {
    const range = Array.isArray(this.props.range) ? (this.props.range as unknown[]) : [];
    const selected = [Math.max(0, Math.min(range.length - 1, Number(this.value) || 0))];
    return {
      columns: [range.map((item) => this.label(item))],
      selected,
      select: (_, index) => (selected[0] = index),
      detail: () => ({ value: selected[0] }),
    };
  }

  private multiModel(keep?: number[]): Model {
    const range = Array.isArray(this.props.range) ? (this.props.range as unknown[]) : [];
    const columns = range.map((column) =>
      (Array.isArray(column) ? column : []).map((item) => this.label(item)),
    );
    const value = Array.isArray(this.value) ? (this.value as unknown[]) : [];
    const selected = columns.map((column, index) =>
      Math.max(0, Math.min(column.length - 1, Number(keep ? keep[index] : value[index]) || 0)),
    );
    return {
      columns,
      selected,
      select: (column, index) => {
        selected[column] = index;
        emit(this, "columnchange", { column, value: index });
      },
      detail: () => ({ value: [...selected] }),
    };
  }

  private dateModel(): Model {
    const fields = (
      ["year", "month", "day"].includes(this.str("fields")) ? this.str("fields") : "day"
    ) as DateFields;
    const suffixes = ["年", "月", "日"];
    const build = (value: string) => {
      const { columns, value: parts } = dateColumns(
        value,
        this.str("start"),
        this.str("end"),
        fields,
        new Date(),
      );
      return {
        parts,
        values: columns,
        columns: columns.map((column, i) =>
          column.map((part) => `${i === 0 ? part : String(part).padStart(2, "0")}${suffixes[i]}`),
        ),
        selected: columns.map((column, i) => column.indexOf(parts[i]!)),
      };
    };
    let state = build(this.str("value"));
    const model: Model = {
      columns: state.columns,
      selected: state.selected,
      select: (column, index) => {
        const parts = [...state.parts];
        parts[column] = state.values[column]![index]!;
        state = build(formatDate(parts));
        model.columns = state.columns;
        model.selected = state.selected;
      },
      detail: () => ({ value: formatDate(state.parts) }),
    };
    return model;
  }

  private timeModel(): Model {
    const build = (value: string) => {
      const { columns, value: parts } = timeColumns(
        value,
        this.str("start"),
        this.str("end"),
        new Date(),
      );
      return {
        parts,
        values: columns,
        columns: columns.map((column) => column.map((part) => String(part).padStart(2, "0"))),
        selected: columns.map((column, i) => column.indexOf(parts[i]!)),
      };
    };
    let state = build(this.str("value"));
    const model: Model = {
      columns: state.columns,
      selected: state.selected,
      select: (column, index) => {
        const parts = [...state.parts];
        parts[column] = state.values[column]![index]!;
        state = build(formatTime(parts));
        model.columns = state.columns;
        model.selected = state.selected;
      },
      detail: () => ({ value: formatTime(state.parts) }),
    };
    return model;
  }

  private regionModel(): Model {
    const depth = regionDepth(this.str("level", "region"));
    const custom = this.str("custom-item");
    // Streets load when a district needs them; the open sheet then shows them
    const loaded = () => {
      if (this.model !== model) return;
      const path = initial ? regionPathOf(this.value, depth, custom) : state.path;
      state = regionColumns(path, depth, custom, loaded);
      model.columns = state.columns;
      model.selected = state.path;
      this.sheet?.show(model.columns, model.selected);
    };
    // Until the user moves a column, the value's street is looked for once its district's streets arrive
    let initial = true;
    let state = regionColumns(
      regionPathOf(this.value, depth, custom, loaded),
      depth,
      custom,
      loaded,
    );
    const model: Model = {
      columns: state.columns,
      selected: state.path,
      select: (column, index) => {
        initial = false;
        // Moving a column starts the columns after it at their first item
        const path = state.path.map((part, i) => (i < column ? part : i === column ? index : 0));
        state = regionColumns(path, depth, custom, loaded);
        model.columns = state.columns;
        model.selected = state.path;
      },
      detail: () => regionResult(state.path, depth, custom),
      loading: () => streetsLoading(state.path, depth, custom),
    };
    return model;
  }
}
