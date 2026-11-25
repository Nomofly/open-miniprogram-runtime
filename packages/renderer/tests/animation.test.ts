import { describe, expect, test } from "vite-plus/test";
import {
  keyframeOf,
  stepStarts,
  stepStyles,
  transformFunction,
  withoutFields,
} from "../src/animation.ts";
import { convertRpx } from "../src/render.ts";

const convert = (css: string) => convertRpx(css, 375);

describe("animations in the view", () => {
  test("transform functions: angles in deg, translations in px, strings kept with rpx converted", () => {
    expect(transformFunction("rotate", [45], convert)).toBe("rotate(45deg)");
    expect(transformFunction("rotate3d", [1, 1, 0, 30], convert)).toBe("rotate3d(1, 1, 0, 30deg)");
    expect(transformFunction("skew", [10, "0.5turn"], convert)).toBe("skew(10deg, 0.5turn)");
    expect(transformFunction("translate", [30, "100rpx"], convert)).toBe("translate(30px, 50px)");
    expect(transformFunction("translate3d", [1, 2, 3], convert)).toBe("translate3d(1px, 2px, 3px)");
    expect(transformFunction("scale", [2, 2], convert)).toBe("scale(2, 2)");
    expect(transformFunction("matrix", [1, 0, 0, 1, 10, 20], convert)).toBe(
      "matrix(1, 0, 0, 1, 10, 20)",
    );
  });

  test("an exported step sets transforms by name and styles by property", () => {
    expect(
      stepStyles(
        [
          { type: "rotate", args: [45] },
          { type: "scale", args: [2, 2] },
          { type: "style", args: ["width", "200rpx"] },
          { type: "style", args: ["opacity", 0] },
        ],
        convert,
      ),
    ).toEqual({
      transforms: [
        ["rotate", "rotate(45deg)"],
        ["scale", "scale(2, 2)"],
      ],
      styles: [
        ["width", "100px"],
        ["opacity", "0"],
      ],
    });
  });

  test("each step starts once the steps before it have run their duration and delay", () => {
    const step = (duration: number, delay = 0) => ({
      animates: [],
      option: { transition: { duration, timingFunction: "linear", delay }, transformOrigin: "" },
    });
    expect(stepStarts([step(400), step(1000, 200), step(100)])).toEqual([0, 400, 1600]);
  });

  test("WeChat keyframes become Web Animations keyframes", () => {
    expect(
      keyframeOf(
        {
          offset: 0.9,
          ease: "ease-in",
          scale: [1.5, 1.5],
          rotate: 45,
          translateX: "20rpx",
          opacity: 0.5,
          width: 100,
          left: "10%",
          backgroundColor: "#00FF00",
          transformOrigin: "left top",
        },
        convert,
      ),
    ).toEqual({
      offset: 0.9,
      easing: "ease-in",
      opacity: "0.5",
      width: "100px",
      left: "10%",
      backgroundColor: "#00FF00",
      transformOrigin: "left top",
      transform: "scale(1.5, 1.5) rotate(45deg) translateX(10px)",
    });
  });

  test("clearAnimation options remove fields; transform removes every transform field", () => {
    const frames = [
      { opacity: 1, rotate: 0, scale: [1, 1], offset: 0 },
      { opacity: 0, rotate: 90, scale: [2, 2], offset: 1 },
    ];
    expect(withoutFields(frames, ["opacity", "rotate"])).toEqual([
      { scale: [1, 1], offset: 0 },
      { scale: [2, 2], offset: 1 },
    ]);
    expect(withoutFields(frames, ["transform"])).toEqual([
      { opacity: 1, offset: 0 },
      { opacity: 0, offset: 1 },
    ]);
  });
});
