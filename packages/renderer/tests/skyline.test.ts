// @vitest-environment happy-dom
import { expect, test } from "vite-plus/test";
import { gridColumnCount, masonryColumns } from "../src/components/skyline.ts";

test("masonry puts each child in the column that ends highest, leftmost on a tie", () => {
  // Ends after each: [100, 0], [100, 40], [100, 80], [100, 140], then 20 goes under the 100
  expect(masonryColumns([100, 40, 30, 50, 20], 2, 10)).toEqual([0, 1, 1, 1, 0]);
  expect(masonryColumns([10, 10, 10, 10], 3, 0)).toEqual([0, 1, 2, 0]);
});

test("columns follow cross-axis-count, or as many as keep each within max-cross-axis-extent", () => {
  expect(gridColumnCount(375, 3, 0, 8)).toBe(3);
  expect(gridColumnCount(375, 0, 0, 0)).toBe(2);
  // 375 wide, columns at most 120 with 10 between: 3 columns are 118.3 wide, 2 would be 182.5
  expect(gridColumnCount(375, 2, 120, 10)).toBe(3);
  expect(gridColumnCount(100, 2, 120, 10)).toBe(1);
});
