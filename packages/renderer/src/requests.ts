/** What the view does for app-level APIs: fonts and the keyboard. */
import type { ViewRequest } from "@omr/runtime";

/** Answers a `viewRequest`; rejects with the fail reason. */
export async function answerRequest(
  request: ViewRequest,
  assetBase: string,
): Promise<Record<string, unknown>> {
  switch (request.kind) {
    case "loadFontFace": {
      const font = new FontFace(
        request.family,
        fontSource(request.source, assetBase),
        request.desc,
      );
      await font.load();
      document.fonts.add(font);
      return {};
    }
    case "hideKeyboard": {
      const input = focusedInput();
      if (!input) throw new Error("no focused input");
      input.blur();
      return {};
    }
    case "selectedTextRange": {
      const input = focusedInput();
      return input ? { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 } : {};
    }
  }
}

const focusedInput = () => {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : undefined;
};

/**
 * The CSS `src` of a `wx.loadFontFace` source: `url("…")` as written, or a
 * plain URL wrapped in `url()`. A root-relative path is a code-package file.
 */
export function fontSource(source: string, assetBase: string): string {
  const trimmed = source.trim();
  const match = /^url\(\s*(["']?)(.*?)\1\s*\)$/i.exec(trimmed);
  const url = match ? match[2]! : trimmed;
  const resolved = /^([a-z][\w+.-]*:|\/\/)/i.test(url)
    ? url
    : `${assetBase}${url.replace(/^\/+/, "")}`;
  return `url(${JSON.stringify(resolved)})`;
}
