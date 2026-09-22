import { describe, expect, it } from "vitest";
import { poissonTail } from "./poisson";
import { mulberry32 } from "./rng";
import { cosine, meanVector } from "./vector";

const v = (...xs: number[]) => Float32Array.from(xs);

describe("cosine", () => {
  it("is 1 for the same direction, 0 for orthogonal, -1 for opposite", () => {
    expect(cosine(v(1, 2, 3), v(2, 4, 6))).toBeCloseTo(1, 6);
    expect(cosine(v(1, 0), v(0, 1))).toBeCloseTo(0, 6);
    expect(cosine(v(1, 1), v(-1, -1))).toBeCloseTo(-1, 6);
  });

  it("is 0 rather than NaN when a vector is all zeros", () => {
    expect(cosine(v(0, 0), v(1, 0))).toBe(0);
  });
});

describe("meanVector", () => {
  it("averages element by element", () => {
    expect(Array.from(meanVector([v(1, 3), v(3, 5)]))).toEqual([2, 4]);
  });
});

describe("poissonTail", () => {
  it("matches the design's worked example: 5 failures when 0.05 are expected", () => {
    // sum_{k>=5} e^-0.05 0.05^k / k! = 2.497951336e-9 (60-digit decimal arithmetic)
    expect(poissonTail(5, 0.05)).toBeCloseTo(2.497951336e-9, 17);
  });

  it("is 1 for at least zero events and 1 - e^-mu for at least one", () => {
    expect(poissonTail(0, 3)).toBe(1);
    expect(poissonTail(1, 1)).toBeCloseTo(1 - Math.exp(-1), 12);
  });

  it("stays accurate far in the tail instead of rounding to zero", () => {
    // P(N >= 12 | mu = 0.05) = 4.867002e-25 (60-digit decimal arithmetic); 1 - CDF would round to 0
    const p = poissonTail(12, 0.05);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeCloseTo(4.867002e-25, 30);
  });
});

describe("mulberry32", () => {
  it("repeats the same sequence for the same seed and stays in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const first = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(first);
    for (const x of first) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(mulberry32(43)()).not.toBe(first[0]);
  });
});
