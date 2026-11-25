/**
 * The `<canvas>` component. The Mini Program draws in the logic layer, on an
 * OffscreenCanvas there; the view only shows the pictures it sends, so drawing
 * code cannot reach the page and the page cannot slow down drawing.
 */

import { emit } from "./components/base.ts";
import { toText } from "./expression.ts";

export interface CanvasElement extends HTMLElement {
  /** Identifies the canvas to the logic layer, as the `node` of a selector query. */
  readonly canvasNodeId: number;
  omrUpdate(props: Record<string, unknown>): void;
  /** Shows a picture the logic layer drew, scaled to the element's size. */
  omrDraw(bitmap: ImageBitmap): void;
}

/** The canvases on this page, by their node id. */
export const canvasElements = new Map<number, CanvasElement>();
let nextCanvasNodeId = 0;

class WxCanvas extends HTMLElement implements CanvasElement {
  readonly canvasNodeId = ++nextCanvasNodeId;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: ImageBitmapRenderingContext | null;
  private disableScroll = false;
  private canvasId = "";
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host { display: inline-block; position: relative; width: 300px; height: 150px; }
      canvas { display: block; width: 100%; height: 100%; }
      canvas.no-scroll { touch-action: none; }
    </style><canvas></canvas><slot></slot>`;
    this.canvas = root.querySelector("canvas")!;
    this.renderer = this.canvas.getContext("bitmaprenderer");
    // `disable-scroll`: moving a finger on the canvas neither scrolls the page nor zooms it
    this.addEventListener(
      "touchmove",
      (event) => {
        if (this.disableScroll && event.cancelable) event.preventDefault();
      },
      { passive: false },
    );
  }
  connectedCallback(): void {
    canvasElements.set(this.canvasNodeId, this);
    // After the view has made the element its own, so the error event reaches the logic layer
    queueMicrotask(() => this.checkCanvasId());
  }
  disconnectedCallback(): void {
    canvasElements.delete(this.canvasNodeId);
  }
  omrUpdate(props: Record<string, unknown>): void {
    // As on WeChat, any non-empty string, including "false", is true
    this.disableScroll = Boolean(props["disable-scroll"]);
    this.canvas.classList.toggle("no-scroll", this.disableScroll);
    this.canvasId = props["canvas-id"] === undefined ? "" : toText(props["canvas-id"]);
  }
  /**
   * A `canvas-id` already used in the same page or component hides this
   * canvas and raises `error`; the first canvas with the id keeps working.
   */
  private checkCanvasId(): void {
    if (!this.isConnected || !this.canvasId) return;
    const scope = this.closest("[omr-host]");
    const first = [...canvasElements.values()].find(
      (other) =>
        other instanceof WxCanvas &&
        other.isConnected &&
        other.canvasId === this.canvasId &&
        other.closest("[omr-host]") === scope,
    );
    // The map keeps the order canvases were added in, so the one that came first keeps the id
    if (!first || first === this) return;
    this.canvas.style.display = "none";
    emit(this, "error", {
      errMsg: `canvas-id "${this.canvasId}" is already used by another canvas on this page`,
    });
  }
  omrDraw(bitmap: ImageBitmap): void {
    this.canvas.width = bitmap.width;
    this.canvas.height = bitmap.height;
    this.renderer?.transferFromImageBitmap(bitmap);
  }
}

export const CANVAS_DEFINITIONS: [string, CustomElementConstructor][] = [["wx-canvas", WxCanvas]];
