import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualClock, ScaledClock } from "./clock";

describe("ScaledClock", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("runs scenario time faster than wall time by the speed factor", () => {
    const clock = new ScaledClock(50_000, 10);
    vi.advanceTimersByTime(1_000);
    expect(clock.now()).toBe(60_000);
  });

  it("sleeps for scenario milliseconds divided by the speed", async () => {
    const clock = new ScaledClock(0, 4);
    let done = false;
    void clock.sleep(8_000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });
});

describe("ManualClock", () => {
  it("only moves when told to", () => {
    const clock = new ManualClock(100);
    clock.advance(50);
    expect(clock.now()).toBe(150);
    clock.set(10);
    expect(clock.now()).toBe(10);
  });
});
