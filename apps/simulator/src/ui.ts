/**
 * Native UI drawn by the shell over the page: toasts, modals, action sheets, the
 * privacy popup, the consent dialogs of authorization, the nickname bar above
 * the keyboard, payment and subscription sheets, the scanner, location pages,
 * the image viewer, and the settings, customer service and feedback pages.
 * Every button has a `data-omr-action` attribute, so automation can answer
 * dialogs by selector.
 */

export type UiHandler = (
  name: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

type Child = Node | string | undefined | false;

function h(tag: string, props: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) el.setAttribute(name, value);
  for (const child of children) if (child) el.append(child);
  return el;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

const SPINNER = `<svg class="omr-spinner" viewBox="0 0 24 24" width="40" height="40"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="42 100" stroke-linecap="round"/></svg>`;
const TOAST_ICONS: Record<string, string> = {
  success: `<svg viewBox="0 0 24 24" width="40" height="40"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  error: `<svg viewBox="0 0 24 24" width="40" height="40"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 7v6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.2" fill="currentColor"/></svg>`,
  loading: SPINNER,
};

export function createUi(
  layer: HTMLElement,
  resolveAsset: (src: string) => string,
  appName: string,
): UiHandler {
  let toast: HTMLElement | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const hideToast = () => {
    clearTimeout(toastTimer);
    toast?.remove();
    toast = undefined;
  };
  const showToast = (title: string, icon: string, mask: boolean, duration?: number) => {
    hideToast();
    const iconSvg = TOAST_ICONS[icon];
    const box = h("div", { class: `omr-toast${iconSvg ? "" : " omr-toast-text"}`, role: "alert" });
    if (iconSvg) box.insertAdjacentHTML("beforeend", iconSvg);
    box.append(h("div", { class: "omr-toast-title" }, title));
    toast = h("div", { class: `omr-toast-layer${mask ? " omr-toast-mask" : ""}` }, box);
    layer.append(toast);
    if (duration !== undefined) toastTimer = setTimeout(hideToast, duration);
  };

  /** Shows a dialog; `build` receives `close`, which removes it and resolves with a result. */
  const dialog = (
    kind: "center" | "sheet" | "full",
    build: (close: (result: Record<string, unknown>) => void) => HTMLElement,
  ) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const close = (result: Record<string, unknown>) => {
        root.remove();
        resolve(result);
      };
      const panel = build(close);
      panel.classList.add(
        kind === "center" ? "omr-modal" : kind === "sheet" ? "omr-sheet" : "omr-fullscreen",
      );
      const root = h("div", { class: "omr-dialog-layer" }, h("div", { class: "omr-mask" }), panel);
      layer.append(root);
    });

  const button = (label: string, action: string, onClick: () => void, extra = "") => {
    const el = h(
      "button",
      { type: "button", class: `omr-button ${extra}`.trim(), "data-omr-action": action },
      label,
    );
    el.addEventListener("click", onClick);
    return el;
  };

  /** The half-screen consent dialog WeChat shows before giving a Mini Program user data. */
  const consent = (
    args: Record<string, unknown>,
    title: string,
    body: Child,
    labels: [deny: string, allow: string] = ["拒绝", "允许"],
  ) =>
    dialog("sheet", (close) =>
      h(
        "div",
        { class: "omr-consent", "data-omr-dialog": "consent" },
        h(
          "div",
          { class: "omr-consent-app" },
          h("span", { class: "omr-app-icon" }, (text(args.appName) || appName).slice(0, 1)),
          h("span", {}, `${text(args.appName) || appName} 申请`),
        ),
        h("div", { class: "omr-consent-title" }, title),
        body,
        h(
          "div",
          { class: "omr-consent-buttons" },
          button(labels[0], "deny", () => close({ allow: false })),
          button(labels[1], "allow", () => close({ allow: true }), "omr-primary"),
        ),
      ),
    );

  /** The full-screen privacy guide `wx.openPrivacyContract` opens. */
  const privacyContract = (contractName: string) =>
    dialog("sheet", (close) =>
      h(
        "div",
        { class: "omr-contract", "data-omr-dialog": "privacyContract" },
        h("div", { class: "omr-contract-title" }, contractName),
        h(
          "div",
          { class: "omr-contract-body" },
          "开发者在小程序管理后台填写的《小程序用户隐私保护指引》显示在这里。模拟器不包含指引正文。",
        ),
        button("返回", "close", () => close({}), "omr-contract-close"),
      ),
    );

  let closeNicknameBar: ((result: Record<string, unknown>) => void) | undefined;
  /** The bar above the keyboard of `<input type="nickname">`; it does not take focus from the input. */
  const nicknameBar = (nickName: string) =>
    new Promise<Record<string, unknown>>((resolve) => {
      closeNicknameBar?.({});
      const choose = button("", "useNickname", () => close({ nickName }), "omr-nickname-option");
      choose.append(
        h("span", { class: "omr-nickname-label" }, "用微信昵称"),
        h("span", { class: "omr-nickname-value" }, nickName),
      );
      choose.addEventListener("mousedown", (event) => event.preventDefault());
      const bar = h(
        "div",
        { class: "omr-nickname-bar", "data-omr-dialog": "nicknameKeyboard" },
        choose,
      );
      const close = (result: Record<string, unknown>) => {
        bar.remove();
        if (closeNicknameBar === close) closeNicknameBar = undefined;
        resolve(result);
      };
      closeNicknameBar = close;
      layer.append(bar);
    });

  /** The bar of a full-screen system page: a cancel button and a title; the capsule stays on its right. */
  const pageBar = (title: string, onCancel: () => void) =>
    h(
      "div",
      { class: "omr-page-bar" },
      button("取消", "cancel", onCancel, "omr-page-bar-cancel"),
      h("span", { class: "omr-page-bar-title" }, title),
      h("span", {}),
    );

  /** The bar of a full-screen WeChat page with a back arrow instead of a cancel button. */
  const backBar = (title: string, onBack: () => void) =>
    h(
      "div",
      { class: "omr-page-bar" },
      button("‹", "back", onBack, "omr-page-bar-back"),
      h("span", { class: "omr-page-bar-title" }, title),
      h("span", {}),
    );

  /** The settings page of `wx.openSetting`: a switch per scope; going back resolves with the settings. */
  const settings = (args: Record<string, unknown>) =>
    dialog("full", (close) => {
      const scopes = (Array.isArray(args.scopes) ? args.scopes : []) as {
        scope: string;
        description: string;
        allowed: boolean;
      }[];
      const authSetting: Record<string, boolean> = {};
      const rows = scopes.map(({ scope, description, allowed }) => {
        authSetting[scope] = allowed;
        const toggle = h("button", {
          type: "button",
          class: `omr-switch${allowed ? " omr-switch-on" : ""}`,
          role: "switch",
          "aria-checked": String(allowed),
          "aria-label": description,
          "data-omr-action": `toggle-${scope}`,
        });
        toggle.addEventListener("click", () => {
          const on = !authSetting[scope];
          authSetting[scope] = on;
          toggle.classList.toggle("omr-switch-on", on);
          toggle.setAttribute("aria-checked", String(on));
        });
        return h(
          "div",
          { class: "omr-settings-row", "data-scope": scope },
          h("span", {}, description),
          toggle,
        );
      });
      return h(
        "div",
        { class: "omr-settings", "data-omr-dialog": "openSetting" },
        backBar("设置", () => close({ authSetting })),
        h("div", { class: "omr-settings-section" }, `允许${text(args.appName) || appName}使用我的`),
        rows.length
          ? h("div", { class: "omr-settings-group" }, ...rows)
          : h("div", { class: "omr-settings-empty" }, "小程序尚未申请使用你的信息"),
      );
    });

  /** The customer service chat of a `contact` button; resolves `{ tapped: true }` when the user taps the card. */
  const contactChat = (args: Record<string, unknown>) =>
    dialog("full", (close) => {
      const name = text(args.appName) || appName;
      const card = args.card as { title: string; img: string; path: string } | undefined;
      let cardButton: HTMLElement | undefined;
      if (card) {
        cardButton = button("", "openCard", () => close({ tapped: true }), "omr-contact-card");
        cardButton.append(
          h("span", { class: "omr-contact-card-app" }, name),
          h("span", { class: "omr-contact-card-title" }, card.title || name),
          card.img
            ? h("img", { class: "omr-contact-card-img", src: resolveAsset(card.img), alt: "" })
            : h("span", { class: "omr-contact-card-img" }),
          h("span", { class: "omr-contact-card-footer" }, "小程序"),
        );
      }
      return h(
        "div",
        { class: "omr-contact", "data-omr-dialog": "contact" },
        backBar("客服消息", () => close({})),
        h("div", { class: "omr-contact-name" }, name),
        h(
          "div",
          { class: "omr-contact-messages" },
          h(
            "div",
            { class: "omr-contact-message" },
            h("span", { class: "omr-app-icon" }, name.slice(0, 1)),
            h("div", { class: "omr-contact-bubble" }, "你好，请问有什么可以帮你？"),
          ),
          cardButton && h("div", { class: "omr-contact-hint" }, "你可能要发送的小程序"),
          cardButton,
        ),
      );
    });

  /** The feedback page of a `feedback` button; WeChat tells the Mini Program nothing about it. */
  const feedback = () =>
    dialog("full", (close) => {
      const input = h("textarea", {
        class: "omr-feedback-input",
        placeholder: "请填写10个字以上的问题描述，以便我们提供更好的帮助",
      }) as HTMLTextAreaElement;
      return h(
        "div",
        { class: "omr-feedback", "data-omr-dialog": "feedback" },
        backBar("意见反馈", () => close({})),
        h("div", { class: "omr-settings-section" }, "问题和意见"),
        input,
        button(
          "提交",
          "submit",
          () => close({ submitted: true, content: input.value }),
          "omr-feedback-submit",
        ),
      );
    });

  /** A map without tiles: a grid, a pin and the coordinates. */
  const mapPlaceholder = (latitude: unknown, longitude: unknown) =>
    h(
      "div",
      { class: "omr-map" },
      h("div", { class: "omr-map-pin" }),
      h(
        "div",
        { class: "omr-map-coords" },
        `${Number(latitude).toFixed(6)}, ${Number(longitude).toFixed(6)}`,
      ),
    );

  /** The amount of a payment in fen, as WeChat Pay shows it. */
  const yuan = (fen: unknown) => (typeof fen === "number" ? `¥${(fen / 100).toFixed(2)}` : "");

  /** The full-screen viewer of `wx.previewImage` and `wx.previewMedia`; resolves when it closes. */
  const preview = (args: Record<string, unknown>) =>
    dialog("full", (close) => {
      const sources = (Array.isArray(args.sources) ? args.sources : []) as {
        url: string;
        type: string;
        poster?: string;
      }[];
      let index = Math.min(Math.max(0, Number(args.current) || 0), Math.max(0, sources.length - 1));
      const stage = h("div", { class: "omr-preview-stage" });
      const counter = h("div", { class: "omr-preview-counter" });
      const render = () => {
        const source = sources[index];
        counter.textContent = sources.length > 1 ? `${index + 1}/${sources.length}` : "";
        if (!source) {
          stage.replaceChildren();
          return;
        }
        const media =
          source.type === "video"
            ? h("video", {
                class: "omr-preview-media",
                src: resolveAsset(source.url),
                controls: "",
                ...(source.poster ? { poster: resolveAsset(source.poster) } : {}),
              })
            : h("img", { class: "omr-preview-media", src: resolveAsset(source.url), alt: "" });
        if (source.type !== "video") media.addEventListener("click", () => close({}));
        stage.replaceChildren(media);
      };
      const step = (delta: number) => () => {
        index = (index + delta + sources.length) % sources.length;
        render();
      };
      render();
      const root = h(
        "div",
        { class: "omr-preview", "data-omr-dialog": "previewImage" },
        counter,
        stage,
        sources.length > 1 && button("‹", "prev", step(-1), "omr-preview-prev"),
        sources.length > 1 && button("›", "next", step(1), "omr-preview-next"),
        button("×", "close", () => close({}), "omr-preview-close"),
      );
      return root;
    });

  const avatar = (src: unknown) =>
    h("img", { class: "omr-avatar", src: resolveAsset(text(src)), alt: "" });

  return async (name, args) => {
    switch (name) {
      case "showToast":
        showToast(text(args.title), text(args.icon), Boolean(args.mask), Number(args.duration));
        return {};
      case "showLoading":
        showToast(text(args.title), "loading", Boolean(args.mask));
        return {};
      case "hideToast":
      case "hideLoading":
        hideToast();
        return {};
      case "showModal":
        return dialog("center", (close) => {
          const input = args.editable
            ? (h("textarea", {
                class: "omr-modal-input",
                placeholder: text(args.placeholderText),
              }) as HTMLTextAreaElement)
            : undefined;
          if (input) input.value = text(args.content);
          return h(
            "div",
            { "data-omr-dialog": "modal" },
            args.title ? h("div", { class: "omr-modal-title" }, text(args.title)) : undefined,
            input ??
              (args.content
                ? h("div", { class: "omr-modal-content" }, text(args.content))
                : undefined),
            h(
              "div",
              { class: "omr-modal-buttons" },
              args.showCancel !== false &&
                button(text(args.cancelText), "cancel", () =>
                  close({ confirm: false, cancel: true }),
                ),
              button(
                text(args.confirmText),
                "confirm",
                () =>
                  close({
                    confirm: true,
                    cancel: false,
                    ...(input ? { content: input.value } : {}),
                  }),
                "omr-primary",
              ),
            ),
          );
        });
      case "showActionSheet":
        return dialog("sheet", (close) => {
          const items = Array.isArray(args.itemList) ? args.itemList.map(String) : [];
          return h(
            "div",
            { class: "omr-action-sheet", "data-omr-dialog": "actionSheet" },
            args.alertText
              ? h("div", { class: "omr-action-alert" }, text(args.alertText))
              : undefined,
            ...items.map((item, index) =>
              button(item, `item-${index}`, () => close({ tapIndex: index })),
            ),
            h("div", { class: "omr-action-gap" }),
            button("取消", "cancel", () => close({})),
          );
        });
      case "authorize":
        return consent(args, text(args.description), undefined);
      case "privacy": {
        const app = text(args.appName) || appName;
        const contractName = text(args.contractName);
        const link = h(
          "span",
          { class: "omr-link", "data-omr-action": "openContract" },
          contractName,
        );
        link.addEventListener("click", () => void privacyContract(contractName));
        return consent(
          args,
          "用户隐私保护提示",
          h(
            "div",
            { class: "omr-consent-body omr-consent-desc" },
            `感谢你使用${app}。在使用前，请仔细阅读`,
            link,
            `。如你同意该指引，请点击“同意”开始使用。`,
          ),
          ["拒绝", "同意"],
        );
      }
      case "privacyContract":
        return privacyContract(text(args.contractName));
      case "nicknameKeyboard":
        return nicknameBar(text(args.nickName));
      case "hideNicknameKeyboard":
        closeNicknameBar?.({});
        return {};
      case "phoneNumber":
        return consent(
          args,
          "申请获取并验证你的手机号",
          h(
            "div",
            { class: "omr-consent-body omr-consent-row" },
            h("span", { class: "omr-phone" }, text(args.phoneNumber)),
            h("span", { class: "omr-consent-note" }, "微信绑定号码"),
          ),
          ["不允许", "允许"],
        );
      case "chooseAvatar":
        return dialog("sheet", (close) => {
          const useAvatar = button(
            "使用微信头像",
            "allow",
            () => close({ allow: true }),
            "omr-avatar-option",
          );
          useAvatar.prepend(avatar(args.avatarUrl));
          return h(
            "div",
            { class: "omr-action-sheet", "data-omr-dialog": "chooseAvatar" },
            useAvatar,
            h("div", { class: "omr-action-gap" }),
            button("取消", "deny", () => close({ allow: false })),
          );
        });
      case "payment":
        return dialog("sheet", (close) =>
          h(
            "div",
            { class: "omr-payment", "data-omr-dialog": "payment" },
            button("×", "cancel", () => close({ pay: false }), "omr-payment-close"),
            h("div", { class: "omr-payment-title" }, "微信支付"),
            h("div", { class: "omr-payment-payee" }, `付款给 ${text(args.appName) || appName}`),
            h(
              "div",
              { class: "omr-payment-amount" },
              yuan(args.amount) || h("span", { class: "omr-payment-unknown" }, "模拟支付"),
            ),
            h(
              "div",
              { class: "omr-payment-row" },
              h("span", {}, "付款方式"),
              h("span", { class: "omr-payment-method" }, "零钱"),
            ),
            button("支付", "pay", () => close({ pay: true }), "omr-payment-pay"),
          ),
        );
      case "subscribeMessage":
        return dialog("sheet", (close) => {
          const ids = (Array.isArray(args.tmplIds) ? args.tmplIds : []).map(String);
          const accepted = new Set(ids);
          const rows = ids.map((id, index) => {
            const toggle = h("button", {
              type: "button",
              class: "omr-switch omr-switch-on",
              role: "switch",
              "aria-checked": "true",
              "data-omr-action": `toggle-${index}`,
            });
            toggle.addEventListener("click", () => {
              const on = !accepted.delete(id);
              if (on) accepted.add(id);
              toggle.classList.toggle("omr-switch-on", on);
              toggle.setAttribute("aria-checked", String(on));
            });
            return h(
              "div",
              { class: "omr-subscribe-row", "data-tmpl-id": id },
              h("span", { class: "omr-subscribe-id" }, id),
              toggle,
            );
          });
          return h(
            "div",
            { class: "omr-consent", "data-omr-dialog": "subscribeMessage" },
            h(
              "div",
              { class: "omr-consent-app" },
              h("span", { class: "omr-app-icon" }, (text(args.appName) || appName).slice(0, 1)),
              h("span", {}, `${text(args.appName) || appName} 申请`),
            ),
            h("div", { class: "omr-consent-title" }, "发送以下订阅消息"),
            h("div", { class: "omr-consent-body omr-subscribe-list" }, ...rows),
            h(
              "div",
              { class: "omr-consent-buttons" },
              button("取消", "deny", () => close({ accepted: [] })),
              button(
                "允许",
                "allow",
                () => close({ accepted: ids.filter((id) => accepted.has(id)) }),
                "omr-primary",
              ),
            ),
          );
        });
      case "scanCode":
        return dialog("full", (close) =>
          h(
            "div",
            { class: "omr-scan", "data-omr-dialog": "scanCode" },
            button("×", "cancel", () => close({}), "omr-scan-close"),
            h("div", { class: "omr-scan-frame" }, h("div", { class: "omr-scan-line" })),
            h("div", { class: "omr-scan-tip" }, "将二维码/条码放入框内，即可自动扫描"),
            h("div", { class: "omr-scan-result" }, `模拟识别结果：${text(args.result)}`),
            button("识别", "scan", () => close({ scanned: true }), "omr-scan-button"),
            args.onlyFromCamera
              ? undefined
              : button("相册", "album", () => close({ scanned: true }), "omr-scan-album"),
          ),
        );
      case "chooseLocation":
        return dialog("full", (close) =>
          h(
            "div",
            { class: "omr-location", "data-omr-dialog": "chooseLocation" },
            pageBar("位置", () => close({})),
            mapPlaceholder(args.latitude, args.longitude),
            h(
              "div",
              { class: "omr-location-item omr-location-selected" },
              h("div", { class: "omr-location-name" }, text(args.name)),
              h("div", { class: "omr-location-address" }, text(args.address)),
              button("完成", "confirm", () => close({ confirm: true }), "omr-location-done"),
            ),
          ),
        );
      case "openLocation":
        return dialog("full", (close) =>
          h(
            "div",
            { class: "omr-location", "data-omr-dialog": "openLocation" },
            pageBar("位置", () => close({})),
            mapPlaceholder(args.latitude, args.longitude),
            h(
              "div",
              { class: "omr-location-item" },
              h("div", { class: "omr-location-name" }, text(args.name) || "位置"),
              h("div", { class: "omr-location-address" }, text(args.address)),
            ),
          ),
        );
      case "previewImage":
        return preview(args);
      case "openSetting":
        return settings(args);
      case "contact":
        return contactChat(args);
      case "feedback":
        return feedback();
      default:
        console.warn(`[omr] the simulator does not show "${name}"`);
        return {};
    }
  };
}
