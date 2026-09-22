import type { Clock } from "./ports";

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Scenario time that runs `speed` times faster than wall time, starting at `start`. */
export class ScaledClock implements Clock {
  private readonly wallStart = Date.now();

  constructor(
    private readonly start: number,
    readonly speed: number,
  ) {}

  now(): number {
    return this.start + (Date.now() - this.wallStart) * this.speed;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms / this.speed));
  }
}

/** Time that moves only when told to; sleeps resolve immediately. For tests and the eval. */
export class ManualClock implements Clock {
  constructor(private current: number) {}

  now(): number {
    return this.current;
  }

  set(time: number): void {
    this.current = time;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  sleep(): Promise<void> {
    return Promise.resolve();
  }
}
