export interface Clock {
  now(): Date;
}

export class FixedClock implements Clock {
  constructor(private instant: Date) {}

  now(): Date {
    return new Date(this.instant.getTime());
  }

  /** Test helper: advance the fixed instant. */
  set(instant: Date): void {
    this.instant = new Date(instant.getTime());
  }
}
