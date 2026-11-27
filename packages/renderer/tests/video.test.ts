// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { defineBuiltins, type BuiltinElement } from "../src/builtins.ts";
import { bufferedPercent, dueDanmu, videoControls } from "../src/components/media.ts";

defineBuiltins();

function mount(props: Record<string, unknown>): BuiltinElement {
  const el = document.createElement("wx-video") as unknown as BuiltinElement;
  el.omrUpdate(props);
  document.body.append(el);
  return el;
}
const inner = <T extends Element = HTMLElement>(el: Element, selector: string) =>
  el.shadowRoot!.querySelector<T & Element>(selector)! as T;
const videoOf = (el: Element) => inner<HTMLVideoElement>(el, "video");
const events = (el: Element) => {
  const fired: { name: string; detail: Record<string, unknown> }[] = [];
  el.addEventListener("omr-event", (event) =>
    fired.push((event as CustomEvent<{ name: string; detail: Record<string, unknown> }>).detail),
  );
  return fired;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("video controls from attributes", () => {
  const paused = { paused: true, width: 300 };
  const playing = { paused: false, width: 300 };

  test("by default: the bar with play, progress and full screen, the center play button while paused", () => {
    expect(videoControls({}, paused)).toEqual({
      bar: true,
      play: true,
      centerToggle: false,
      centerPlay: true,
      progress: true,
      mute: false,
      fullScreen: true,
      danmu: false,
      poster: false,
    });
    expect(videoControls({}, playing).centerPlay).toBe(false);
  });

  test("unset show-progress shows only wider than 240px; set, it decides", () => {
    expect(videoControls({}, { paused: true, width: 240 }).progress).toBe(false);
    expect(videoControls({ "show-progress": true }, { paused: true, width: 200 }).progress).toBe(
      true,
    );
    expect(videoControls({ "show-progress": false }, paused).progress).toBe(false);
  });

  test("each show-* attribute and play-btn-position", () => {
    const plan = videoControls(
      {
        "show-fullscreen-btn": false,
        "show-center-play-btn": false,
        "show-mute-btn": true,
        "danmu-btn": true,
        poster: "a.png",
      },
      paused,
    );
    expect(plan).toMatchObject({
      fullScreen: false,
      centerPlay: false,
      mute: true,
      danmu: true,
      poster: true,
    });
    expect(videoControls({ "show-play-btn": false }, playing)).toMatchObject({
      play: false,
      centerToggle: false,
    });
    expect(videoControls({ "play-btn-position": "center" }, playing)).toMatchObject({
      play: false,
      centerToggle: true,
    });
  });

  test("without controls only the center play button is left, and the poster is ignored", () => {
    const plan = videoControls({ controls: false, poster: "a.png", "show-mute-btn": true }, paused);
    expect(plan).toEqual({
      bar: false,
      play: false,
      centerToggle: false,
      centerPlay: true,
      progress: false,
      mute: false,
      fullScreen: false,
      danmu: false,
      poster: false,
    });
  });
});

describe("danmu-list", () => {
  const list = [
    { text: "first", color: "#ff0000", time: 0 },
    { text: "one", time: 1 },
    { text: "two", color: "#00ff00", time: 2 },
    { text: "", time: 1.5 },
    { time: 1.2 },
  ];

  test("an item shows once, when playback passes its time", () => {
    expect(dueDanmu(list, 0, 0.25)).toEqual([{ text: "first", color: "#ff0000", time: 0 }]);
    expect(dueDanmu(list, 0.25, 0.9)).toEqual([]);
    expect(dueDanmu(list, 0.9, 1.1)).toEqual([{ text: "one", color: "#ffffff", time: 1 }]);
    expect(dueDanmu(list, 1.1, 2)).toEqual([]);
    expect(dueDanmu(list, 2, 2.2).map((item) => item.text)).toEqual(["two"]);
  });

  test("nothing while time stands still or goes back", () => {
    expect(dueDanmu(list, 1, 1)).toEqual([]);
    expect(dueDanmu(list, 3, 0.5)).toEqual([]);
    expect(dueDanmu(undefined, 0, 5)).toEqual([]);
  });
});

describe("buffered percentage", () => {
  const ranges = (...parts: [number, number][]) => ({
    length: parts.length,
    start: (i: number) => parts[i]![0],
    end: (i: number) => parts[i]![1],
  });

  test("the end of the loaded part holding the current time, else the first", () => {
    expect(bufferedPercent(ranges([0, 2]), 0, 8)).toBe(25);
    expect(bufferedPercent(ranges([0, 2], [5, 7.9]), 6, 8)).toBe(99);
    expect(bufferedPercent(ranges([0, 2], [5, 7]), 3, 8)).toBe(25);
  });

  test("0 before anything loads or without a duration", () => {
    expect(bufferedPercent(ranges(), 0, 8)).toBe(0);
    expect(bufferedPercent(ranges([0, 2]), 0, Number.NaN)).toBe(0);
    expect(bufferedPercent(ranges([0, 2]), 0, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("video", () => {
  test("its own full screen button raises fullscreenchange and asks for the whole screen", () => {
    const el = mount({ src: "clip.mp4", direction: 0 });
    const fired = events(el);
    const asked: boolean[] = [];
    const listener = (event: Event) =>
      asked.push((event as CustomEvent<{ fullScreen: boolean }>).detail.fullScreen);
    document.addEventListener("omr-video-fullscreen", listener);
    const button = inner(el, ".fullscreen");
    expect(button.hidden).toBe(false);
    button.click();
    expect(inner(el, ".top").hidden).toBe(false);
    button.click();
    document.removeEventListener("omr-video-fullscreen", listener);
    expect(fired.filter((event) => event.name === "fullscreenchange")).toEqual([
      { name: "fullscreenchange", detail: { fullScreen: true, direction: "vertical" } },
      { name: "fullscreenchange", detail: { fullScreen: false, direction: "vertical" } },
    ]);
    expect(asked).toEqual([true, false]);
  });

  test("show-fullscreen-btn false hides the button; the browser's own controls are never used", () => {
    const el = mount({ src: "clip.mp4", "show-fullscreen-btn": false });
    expect(inner(el, ".fullscreen").hidden).toBe(true);
    expect(videoOf(el).controls).toBe(false);
  });

  test("the title shows only in full screen", () => {
    const el = mount({ src: "clip.mp4", title: "Big Buck" });
    expect(inner(el, ".top").hidden).toBe(true);
    void el.omrCall!("requestFullScreen", [{ direction: 90 }]);
    expect(inner(el, ".top").hidden).toBe(false);
    expect(inner(el, ".title").textContent).toBe("Big Buck");
  });

  test("a later render keeps the mute the user chose", () => {
    const el = mount({ src: "clip.mp4", muted: false });
    const video = videoOf(el);
    video.muted = true;
    el.omrUpdate({ src: "clip.mp4", muted: false, title: "x" });
    expect(video.muted).toBe(true);
    // A change from the logic layer still applies
    el.omrUpdate({ src: "clip.mp4", muted: true });
    el.omrUpdate({ src: "clip.mp4", muted: false });
    expect(video.muted).toBe(false);
  });

  test("autoplay that the browser blocks with sound plays muted", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      return this.muted
        ? Promise.resolve()
        : Promise.reject(new DOMException("blocked", "NotAllowedError"));
    });
    const el = mount({ src: "clip.mp4", autoplay: true });
    await settle();
    expect(play).toHaveBeenCalledTimes(2);
    expect(videoOf(el).muted).toBe(true);
  });

  test("binderror gives the reason of the MediaError code", () => {
    const el = mount({ src: "clip.mp4" });
    const fired = events(el);
    const video = videoOf(el);
    Object.defineProperty(video, "error", { value: { code: 2, message: "" } });
    video.dispatchEvent(new Event("error"));
    expect(fired).toEqual([{ name: "error", detail: { errMsg: "MEDIA_ERR_NETWORK" } }]);
  });

  test("a tap on the picture hides and shows the controls with controlstoggle", () => {
    const el = mount({ src: "clip.mp4" });
    const fired = events(el);
    videoOf(el).click();
    expect(inner(el, ".bar").hidden).toBe(true);
    videoOf(el).click();
    expect(inner(el, ".bar").hidden).toBe(false);
    expect(fired).toEqual([
      { name: "controlstoggle", detail: { show: false } },
      { name: "controlstoggle", detail: { show: true } },
    ]);
  });

  test("turned sideways in full screen, dragging along the progress bar seeks along its turned length", () => {
    const el = mount({ src: "clip.mp4" });
    const video = videoOf(el);
    Object.defineProperty(video, "duration", { value: 100 });
    // direction -90 turns the video a quarter clockwise, so the bar runs down the screen
    void el.omrCall!("requestFullScreen", [{ direction: -90 }]);
    vi.spyOn(inner(el, ".track"), "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 20, height: 200 }),
    );
    const progress = inner(el, ".progress");
    progress.dispatchEvent(new PointerEvent("pointerdown", { clientX: 10, clientY: 150 }));
    progress.dispatchEvent(new PointerEvent("pointerup", { clientX: 10, clientY: 150 }));
    expect(video.currentTime).toBe(75);
  });

  test("a sideways full-screen video that leaves the page and comes back seeks along the bar again", () => {
    const el = mount({ src: "clip.mp4" });
    const video = videoOf(el);
    Object.defineProperty(video, "duration", { value: 100 });
    void el.omrCall!("requestFullScreen", [{ direction: -90 }]);
    el.remove();
    document.body.append(el);
    vi.spyOn(inner(el, ".track"), "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 20 }),
    );
    const progress = inner(el, ".progress");
    progress.dispatchEvent(new PointerEvent("pointerdown", { clientX: 50, clientY: 10 }));
    progress.dispatchEvent(new PointerEvent("pointerup", { clientX: 50, clientY: 10 }));
    expect(video.currentTime).toBe(25);
  });

  test("initial-time seeks once the metadata is in, without seekcomplete", () => {
    const el = mount({ src: "clip.mp4", "initial-time": 3 });
    const fired = events(el);
    const video = videoOf(el);
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(video.currentTime).toBe(3);
    video.dispatchEvent(new Event("seeked"));
    expect(fired.map((event) => event.name)).toEqual(["loadedmetadata"]);
  });
});

describe("audio", () => {
  test("clearing src stops the clip that was playing", () => {
    const el = document.createElement("wx-audio") as unknown as BuiltinElement;
    el.omrUpdate({ src: "song.mp3" });
    document.body.append(el);
    const load = vi.spyOn(el.shadowRoot!.querySelector("audio")!, "load");
    el.omrUpdate({ src: "" });
    expect(load).toHaveBeenCalledTimes(1);
    void el.omrCall!("setSrc", [""]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("setSrc('') clears the clip instead of loading the page's directory, and the card shows play again", () => {
    const el = document.createElement("wx-audio") as unknown as BuiltinElement & {
      omrResolveAsset: (src: string) => string;
    };
    el.omrResolveAsset = (src) => `http://sim.test/pages/index/${src}`;
    el.omrUpdate({ src: "song.mp3", controls: true });
    document.body.append(el);
    const audio = el.shadowRoot!.querySelector("audio")!;
    const button = el.shadowRoot!.querySelector(".button")!;
    const playIcon = button.innerHTML;
    audio.dispatchEvent(new Event("play"));
    expect(button.innerHTML).not.toBe(playIcon);
    void el.omrCall!("setSrc", [""]);
    expect(audio.hasAttribute("src")).toBe(false);
    expect(button.innerHTML).toBe(playIcon);
  });
});
