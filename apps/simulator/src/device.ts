import type { MenuButtonRect, SystemInfo } from "@omr/runtime";

export interface Device {
  brand: string;
  model: string;
  system: string;
  platform: "ios" | "android";
  screenWidth: number;
  screenHeight: number;
  pixelRatio: number;
  statusBarHeight: number;
  navigationBarHeight: number;
  /** Height of the home indicator area below the tab bar. */
  safeAreaBottom: number;
}

/** Device presets, selected with `?device=` on the simulator URL. */
export const DEVICES: Record<string, Device> = {
  "iphone-15": {
    brand: "iPhone",
    model: "iPhone 15",
    system: "iOS 17.0",
    platform: "ios",
    screenWidth: 393,
    screenHeight: 852,
    pixelRatio: 3,
    statusBarHeight: 59,
    navigationBarHeight: 44,
    safeAreaBottom: 34,
  },
  "iphone-se": {
    brand: "iPhone",
    model: "iPhone SE",
    system: "iOS 17.0",
    platform: "ios",
    screenWidth: 375,
    screenHeight: 667,
    pixelRatio: 2,
    statusBarHeight: 20,
    navigationBarHeight: 44,
    safeAreaBottom: 0,
  },
  pixel: {
    brand: "Google",
    model: "Pixel 7",
    system: "Android 14",
    platform: "android",
    screenWidth: 412,
    screenHeight: 915,
    pixelRatio: 2.625,
    statusBarHeight: 24,
    navigationBarHeight: 48,
    safeAreaBottom: 0,
  },
};

export const DEFAULT_DEVICE = "iphone-15";

/** The tab bar's height above the safe area. */
export const TAB_BAR_HEIGHT = 50;

export function systemInfo(device: Device): SystemInfo {
  const windowHeight = device.screenHeight - device.statusBarHeight - device.navigationBarHeight;
  const safeBottom = device.screenHeight - device.safeAreaBottom;
  return {
    brand: device.brand,
    model: device.model,
    system: device.system,
    platform: device.platform,
    pixelRatio: device.pixelRatio,
    screenWidth: device.screenWidth,
    screenHeight: device.screenHeight,
    windowWidth: device.screenWidth,
    windowHeight,
    statusBarHeight: device.statusBarHeight,
    safeArea: {
      left: 0,
      right: device.screenWidth,
      top: device.statusBarHeight,
      bottom: safeBottom,
      width: device.screenWidth,
      height: safeBottom - device.statusBarHeight,
    },
    screenTop: device.statusBarHeight + device.navigationBarHeight,
    language: "zh_CN",
    version: "8.0.50",
    SDKVersion: "3.5.0",
    fontSizeSetting: 16,
    deviceOrientation: "portrait",
    benchmarkLevel: 1,
    enableDebug: false,
  };
}

/** Where the capsule (the menu and close buttons) sits, as `wx.getMenuButtonBoundingClientRect` reports it. */
export function menuButtonRect(device: Device): MenuButtonRect {
  const width = 87;
  const height = 32;
  const top = device.statusBarHeight + (device.navigationBarHeight - height) / 2;
  const right = device.screenWidth - 7;
  return { width, height, top, right, bottom: top + height, left: right - width };
}
