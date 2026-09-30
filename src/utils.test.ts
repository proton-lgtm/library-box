import { describe, expect, it } from "vitest";
import { formatBytes, progressPercent } from "./utils";

describe("download display helpers", () => {
  it("formats byte sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("bounds progress and handles unknown totals", () => {
    expect(progressPercent(25, 100)).toBe(25);
    expect(progressPercent(150, 100)).toBe(100);
    expect(progressPercent(25, null)).toBe(0);
  });
});
