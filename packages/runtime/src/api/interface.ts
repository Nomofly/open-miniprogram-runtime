/**
 * Interface APIs of the window around the page: the tab bar, the navigation
 * bar's loading indicator and home button, the window background and pull-down
 * refresh. The shell draws the chrome and fails a call that does not apply,
 * such as a tab bar API on a page without the tab bar.
 */
import { asyncApi, type Options } from "./common.ts";
import type { ApiContext } from "./context.ts";

export function createInterfaceApis({ host }: ApiContext): Record<string, unknown> {
  const currentWebview = () => {
    const webviewId = host.topWebviewId();
    if (webviewId === undefined) throw new Error("no page is open");
    return webviewId;
  };
  /** An API the shell performs for the current page. */
  const shellApi = (
    name: string,
    args: (options: Options) => Record<string, unknown> = () => ({}),
  ) =>
    asyncApi(name, async (options) => {
      const result = await host.ui(name, { webviewId: currentWebview(), ...args(options) });
      return result;
    });
  const index = (options: Options) => ({ index: Number(options.index) });
  const tabBarVisibility = (name: string, hidden: boolean) =>
    asyncApi(name, async (options) => {
      await host.ui(name, { webviewId: currentWebview(), animation: Boolean(options.animation) });
      host.setTabBarHidden(hidden);
      return {};
    });

  const pullDown = (refreshing: boolean) => async () => {
    host.sendView(currentWebview(), { type: "pullDownRefresh", refreshing });
    return {};
  };

  return {
    setTabBarBadge: shellApi("setTabBarBadge", (options) => ({
      ...index(options),
      text: String(options.text ?? ""),
    })),
    removeTabBarBadge: shellApi("removeTabBarBadge", index),
    showTabBarRedDot: shellApi("showTabBarRedDot", index),
    hideTabBarRedDot: shellApi("hideTabBarRedDot", index),
    setTabBarStyle: shellApi("setTabBarStyle", (options) => ({
      color: options.color,
      selectedColor: options.selectedColor,
      backgroundColor: options.backgroundColor,
      borderStyle: options.borderStyle,
    })),
    setTabBarItem: shellApi("setTabBarItem", (options) => ({
      ...index(options),
      text: options.text,
      iconPath: options.iconPath,
      selectedIconPath: options.selectedIconPath,
      pagePath: options.pagePath,
    })),
    showTabBar: tabBarVisibility("showTabBar", false),
    hideTabBar: tabBarVisibility("hideTabBar", true),

    showNavigationBarLoading: shellApi("showNavigationBarLoading"),
    hideNavigationBarLoading: shellApi("hideNavigationBarLoading"),
    hideHomeButton: shellApi("hideHomeButton"),

    setBackgroundColor: asyncApi("setBackgroundColor", async (options) => {
      host.sendView(currentWebview(), {
        type: "background",
        color: options.backgroundColor,
        top: options.backgroundColorTop,
        bottom: options.backgroundColorBottom,
      });
      return {};
    }),
    setBackgroundTextStyle: asyncApi("setBackgroundTextStyle", async (options) => {
      const textStyle = String(options.textStyle ?? "");
      if (textStyle !== "dark" && textStyle !== "light") {
        throw new Error(`invalid textStyle "${textStyle}"`);
      }
      host.sendView(currentWebview(), { type: "background", textStyle });
      return {};
    }),
    startPullDownRefresh: asyncApi("startPullDownRefresh", pullDown(true)),
    stopPullDownRefresh: asyncApi("stopPullDownRefresh", pullDown(false)),
  };
}
