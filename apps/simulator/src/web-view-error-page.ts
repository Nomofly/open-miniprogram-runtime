/** What a `<web-view>` shows when its page cannot be opened, served by the proxy or drawn by the shell. */
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

/** The error page for a URL; `head` goes into its head, such as the proxy's bridge script. */
export function webViewErrorPage(url: string, reason: string, head = ""): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>无法打开网页</title>
    ${head}
    <style>
      body { margin: 0; padding: 96px 32px 0; font: 15px/1.5 -apple-system, "PingFang SC", sans-serif; color: #111; text-align: center; background: #fff; }
      .icon { width: 56px; height: 56px; margin: 0 auto 24px; border-radius: 50%; background: #fa5151; color: #fff; font: 600 32px/56px sans-serif; }
      h1 { margin: 0 0 12px; font-size: 18px; font-weight: 500; }
      p { margin: 0; color: rgba(0, 0, 0, 0.5); font-size: 13px; word-break: break-all; }
    </style>
  </head>
  <body>
    <div class="icon">!</div>
    <h1>网页无法打开</h1>
    <p>${escapeHtml(url)}</p>
    <p>${escapeHtml(reason)}</p>
  </body>
</html>
`;
}
