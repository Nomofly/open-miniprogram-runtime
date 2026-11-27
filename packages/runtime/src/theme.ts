/**
 * DarkMode: with `"darkmode": true` in app.json, window and tabBar settings
 * may name a variable of theme.json, such as `"@navBgColor"`, whose value
 * depends on the system theme.
 */

export type Theme = "light" | "dark";

/** theme.json: the variables of each theme. */
export interface ThemeVariables {
  light: Record<string, string>;
  dark: Record<string, string>;
}

/** Window settings that may name a variable, in app.json `window` and a page's json. */
const WINDOW_KEYS = [
  "navigationBarBackgroundColor",
  "navigationBarTextStyle",
  "backgroundColor",
  "backgroundTextStyle",
  "backgroundColorTop",
  "backgroundColorBottom",
];
const TAB_BAR_KEYS = ["color", "selectedColor", "backgroundColor", "borderStyle"];
const TAB_ITEM_KEYS = ["iconPath", "selectedIconPath"];

function resolve(
  config: Record<string, unknown>,
  keys: string[],
  values: Record<string, string>,
): Record<string, unknown> {
  const result = { ...config };
  for (const key of keys) {
    const value = result[key];
    // A variable theme.json does not define stays as written, as WeChat leaves it
    if (
      typeof value === "string" &&
      value.startsWith("@") &&
      Object.hasOwn(values, value.slice(1))
    ) {
      result[key] = values[value.slice(1)];
    }
  }
  return result;
}

/** A window configuration with its variables replaced by their values in `theme`. */
export function themeWindow(
  window: Record<string, unknown>,
  variables: ThemeVariables | undefined,
  theme: Theme,
): Record<string, unknown> {
  return variables ? resolve(window, WINDOW_KEYS, variables[theme] ?? {}) : { ...window };
}

/** A tabBar configuration with its variables, and those of its items' icons, replaced by their values in `theme`. */
export function themeTabBar<T extends { list?: object[] }>(
  tabBar: T,
  variables: ThemeVariables | undefined,
  theme: Theme,
): T {
  if (!variables) return structuredClone(tabBar);
  const values = variables[theme] ?? {};
  const result = resolve(tabBar as Record<string, unknown>, TAB_BAR_KEYS, values) as T;
  if (Array.isArray(tabBar.list)) {
    result.list = tabBar.list.map((item) =>
      resolve(item as Record<string, unknown>, TAB_ITEM_KEYS, values),
    );
  }
  return result;
}
