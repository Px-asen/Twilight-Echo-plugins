export const frameRates = [24, 30, 60, 120] as const;
export type FrameRate = (typeof frameRates)[number];

export function normalizeFrameRate(value: unknown): FrameRate {
  return frameRates.includes(value as FrameRate) ? (value as FrameRate) : 60;
}

/** Keep a deadline rather than sleeping or rounding to a monitor refresh divisor.
 * Animation clocks still receive real timestamps, including at 24 FPS. */
export class FrameLimiter {
  private next: number | undefined;
  private rate = 60;

  reset() {
    this.next = undefined;
  }

  shouldRender(now: number, rate: FrameRate): boolean {
    if (rate !== this.rate) {
      this.rate = rate;
      this.reset();
    }
    const interval = 1000 / rate;
    if (this.next === undefined) {
      this.next = now + interval;
      return true;
    }
    if (now + 0.05 < this.next) return false;
    // Drop missed deadlines after a stall; never replay a backlog of frames.
    this.next +=
      interval *
      Math.max(1, Math.floor((now - this.next + 0.05) / interval) + 1);
    return true;
  }
}
