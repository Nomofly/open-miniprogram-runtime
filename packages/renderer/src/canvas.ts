/**
 * The `<canvas>` component. The Mini Program draws in the logic layer, on an
 * OffscreenCanvas there; the view only shows the pictures it sends, so drawing
 * code cannot reach the page and the page cannot slow down drawing.
 */

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
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host { display: inline-block; position: relative; width: 300px; height: 150px; }
      canvas { display: block; width: 100%; height: 100%; }
    </style><canvas></canvas><slot></slot>`;
    this.canvas = root.querySelector("canvas")!;
    this.renderer = this.canvas.getContext("bitmaprenderer");
  }
  connectedCallback(): void {
    canvasElements.set(this.canvasNodeId, this);
  }
  disconnectedCallback(): void {
    canvasElements.delete(this.canvasNodeId);
  }
  omrUpdate(): void {}
  omrDraw(bitmap: ImageBitmap): void {
    this.canvas.width = bitmap.width;
    this.canvas.height = bitmap.height;
    this.renderer?.transferFromImageBitmap(bitmap);
  }
}

export const CANVAS_DEFINITIONS: [string, CustomElementConstructor][] = [["wx-canvas", WxCanvas]];
