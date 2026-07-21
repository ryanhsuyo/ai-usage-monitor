import { describe, expect, it } from "vitest";
import { formatCompactCountdown } from "./format";

const NOW = Date.parse("2026-07-21T12:00:00.000Z");
const inMinutes = (m: number) => new Date(NOW + m * 60_000).toISOString();

describe("formatCompactCountdown", () => {
  it("never renders a span that could be read as a time of day", () => {
    // 「18時32分」is how Chinese writes 18:32, and this widget also shows real reset moments,
    // so a countdown in that shape was indistinguishable from a clock reading.
    const span = formatCompactCountdown(inMinutes(18 * 60 + 32), NOW)!;
    expect(span).not.toMatch(/^\d+時\d+分$/);
    expect(span).toBe("18時32分後");
  });

  it("labels every unit as elapsed time", () => {
    expect(formatCompactCountdown(inMinutes(4 * 24 * 60), NOW)).toBe("4天0時後");
    expect(formatCompactCountdown(inMinutes(298), NOW)).toBe("4時58分後");
    expect(formatCompactCountdown(inMinutes(45), NOW)).toBe("45分後");
  });

  it("says a reset is underway rather than counting past it", () => {
    expect(formatCompactCountdown(inMinutes(-5), NOW)).toBe("重置中");
    expect(formatCompactCountdown(inMinutes(0), NOW)).toBe("重置中");
  });

  it("returns nothing when there is no usable timestamp", () => {
    expect(formatCompactCountdown(undefined, NOW)).toBeUndefined();
    expect(formatCompactCountdown("not a date", NOW)).toBeUndefined();
  });
});
