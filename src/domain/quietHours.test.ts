import { describe, expect, it } from "vitest";
import { isInQuietHours, normalizeHhMm } from "./quietHours";

describe("normalizeHhMm", () => {
  it("completes bare hours", () => {
    expect(normalizeHhMm("23")).toBe("23:00");
    expect(normalizeHhMm("9")).toBe("09:00");
    expect(normalizeHhMm("0")).toBe("00:00");
  });

  it("splits digit-only input with the last two digits as minutes", () => {
    expect(normalizeHhMm("2300")).toBe("23:00");
    expect(normalizeHhMm("930")).toBe("09:30");
    expect(normalizeHhMm("0905")).toBe("09:05");
  });

  it("reads each side literally when a separator is present", () => {
    expect(normalizeHhMm("23:5")).toBe("23:05");
    expect(normalizeHhMm("9:5")).toBe("09:05");
    expect(normalizeHhMm("23.30")).toBe("23:30");
    expect(normalizeHhMm("23：30")).toBe("23:30"); // fullwidth colon from a CJK IME
    expect(normalizeHhMm("23:")).toBe("23:00");
  });

  it("keeps already-canonical values and trims surrounding space", () => {
    expect(normalizeHhMm("23:00")).toBe("23:00");
    expect(normalizeHhMm("  08:15  ")).toBe("08:15");
  });

  it("treats cleared input as cleared, not invalid", () => {
    expect(normalizeHhMm("")).toBe("");
    expect(normalizeHhMm("   ")).toBe("");
  });

  it("rejects out-of-range and unreadable input instead of guessing", () => {
    expect(normalizeHhMm("24")).toBeUndefined();
    expect(normalizeHhMm("2360")).toBeUndefined();
    expect(normalizeHhMm("25:00")).toBeUndefined();
    expect(normalizeHhMm("12345")).toBeUndefined();
    expect(normalizeHhMm("abc")).toBeUndefined();
    expect(normalizeHhMm("11pm")).toBeUndefined();
  });

  it("produces values the quiet-hours check accepts", () => {
    const start = normalizeHhMm("2300")!;
    const end = normalizeHhMm("9")!;
    expect(isInQuietHours({ start, end }, 23 * 60 + 30)).toBe(true); // 23:30 is quiet
    expect(isInQuietHours({ start, end }, 10 * 60)).toBe(false); // 10:00 is not
  });
});
