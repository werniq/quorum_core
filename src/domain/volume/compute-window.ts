/**
 * Calendar volume windows in a configured IANA timezone (v1).
 */

import type { VolumeWindowBounds, VolumeWindowType } from "./types.js";
import { DEFAULT_WEEK_STARTS_ON } from "./types.js";

const MS_PER_MINUTE = 60_000;

export function isValidIanaTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function zonedParts(date: Date, timezone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Convert local calendar components in timezone to UTC Date (iterative offset fix). */
export function zonedLocalToUtc(
  input: {
    year: number;
    month: number;
    day: number;
    hour?: number;
    minute?: number;
    second?: number;
  },
  timezone: string,
): Date {
  let guess = new Date(
    Date.UTC(
      input.year,
      input.month - 1,
      input.day,
      input.hour ?? 0,
      input.minute ?? 0,
      input.second ?? 0,
    ),
  );
  for (let i = 0; i < 3; i += 1) {
    const parts = zonedParts(guess, timezone);
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const desired = Date.UTC(
      input.year,
      input.month - 1,
      input.day,
      input.hour ?? 0,
      input.minute ?? 0,
      input.second ?? 0,
    );
    guess = new Date(guess.getTime() + (desired - asUtc));
  }
  return guess;
}

function startOfLocalDay(date: Date, timezone: string): Date {
  const p = zonedParts(date, timezone);
  return zonedLocalToUtc(
    { year: p.year, month: p.month, day: p.day, hour: 0, minute: 0, second: 0 },
    timezone,
  );
}

function addLocalDays(
  year: number,
  month: number,
  day: number,
  deltaDays: number,
  timezone: string,
): Date {
  const base = zonedLocalToUtc({ year, month, day, hour: 0 }, timezone);
  return new Date(base.getTime() + deltaDays * 86_400_000);
}

function localWeekday(date: Date, timezone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(date);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[weekday] ?? 0;
}

function startOfLocalMonth(date: Date, timezone: string): Date {
  const p = zonedParts(date, timezone);
  return zonedLocalToUtc(
    { year: p.year, month: p.month, day: 1, hour: 0, minute: 0, second: 0 },
    timezone,
  );
}

function nextLocalMonthStart(date: Date, timezone: string): Date {
  const p = zonedParts(date, timezone);
  const nextMonth = p.month === 12 ? 1 : p.month + 1;
  const nextYear = p.month === 12 ? p.year + 1 : p.year;
  return zonedLocalToUtc(
    { year: nextYear, month: nextMonth, day: 1, hour: 0, minute: 0, second: 0 },
    timezone,
  );
}

export function computeVolumeWindow(
  windowType: VolumeWindowType,
  timezone: string,
  now: Date,
  weekStartsOn: number | null = DEFAULT_WEEK_STARTS_ON,
): { windowStart: Date; windowEnd: Date } {
  if (!isValidIanaTimezone(timezone)) {
    throw new Error(`invalid timezone: ${timezone}`);
  }

  if (windowType === "daily") {
    const windowStart = startOfLocalDay(now, timezone);
    const p = zonedParts(windowStart, timezone);
    const windowEnd = addLocalDays(p.year, p.month, p.day, 1, timezone);
    return { windowStart, windowEnd };
  }

  if (windowType === "monthly") {
    const windowStart = startOfLocalMonth(now, timezone);
    const windowEnd = nextLocalMonthStart(windowStart, timezone);
    return { windowStart, windowEnd };
  }

  const weekStartDay = weekStartsOn ?? DEFAULT_WEEK_STARTS_ON;
  const localDayStart = startOfLocalDay(now, timezone);
  const weekday = localWeekday(localDayStart, timezone);
  const daysFromStart = (weekday - weekStartDay + 7) % 7;
  const p = zonedParts(localDayStart, timezone);
  const windowStart = addLocalDays(
    p.year,
    p.month,
    p.day,
    -daysFromStart,
    timezone,
  );
  const ws = zonedParts(windowStart, timezone);
  const windowEnd = addLocalDays(ws.year, ws.month, ws.day, 7, timezone);
  return { windowStart, windowEnd };
}

function previousVolumeWindow(
  windowType: VolumeWindowType,
  timezone: string,
  currentWindowStart: Date,
  _weekStartsOn: number | null,
): { windowStart: Date; windowEnd: Date } {
  const windowEnd = currentWindowStart;
  if (windowType === "daily") {
    const p = zonedParts(windowEnd, timezone);
    const windowStart = addLocalDays(p.year, p.month, p.day, -1, timezone);
    return { windowStart, windowEnd };
  }

  if (windowType === "monthly") {
    const p = zonedParts(windowEnd, timezone);
    const prevMonth = p.month === 1 ? 12 : p.month - 1;
    const prevYear = p.month === 1 ? p.year - 1 : p.year;
    const windowStart = zonedLocalToUtc(
      {
        year: prevYear,
        month: prevMonth,
        day: 1,
        hour: 0,
        minute: 0,
        second: 0,
      },
      timezone,
    );
    return { windowStart, windowEnd };
  }

  const ws = zonedParts(currentWindowStart, timezone);
  const windowStart = addLocalDays(ws.year, ws.month, ws.day, -7, timezone);
  return { windowStart, windowEnd };
}

function firstPartialFlag(
  ruleActivatedAt: Date,
  windowStart: Date,
  windowEnd: Date,
): boolean {
  return ruleActivatedAt > windowStart && ruleActivatedAt < windowEnd;
}

export function computeVolumeWindowForInstant(input: {
  windowType: VolumeWindowType;
  timezone: string;
  weekStartsOn?: number | null;
  ruleActivatedAt: Date;
  now: Date;
  evaluationGraceMinutes?: number;
}): VolumeWindowBounds {
  const grace = input.evaluationGraceMinutes ?? 0;
  const current = computeVolumeWindow(
    input.windowType,
    input.timezone,
    input.now,
    input.weekStartsOn,
  );
  const previous = previousVolumeWindow(
    input.windowType,
    input.timezone,
    current.windowStart,
    input.weekStartsOn ?? DEFAULT_WEEK_STARTS_ON,
  );
  const prevDeadline = evaluationDeadline(previous.windowEnd, grace);
  const currentDeadline = evaluationDeadline(current.windowEnd, grace);

  if (input.now >= previous.windowEnd && input.now < prevDeadline) {
    return {
      windowStart: previous.windowStart,
      windowEnd: previous.windowEnd,
      isFirstPartialWindow: firstPartialFlag(
        input.ruleActivatedAt,
        previous.windowStart,
        previous.windowEnd,
      ),
    };
  }

  if (input.now > current.windowStart && input.now < current.windowEnd) {
    return {
      windowStart: current.windowStart,
      windowEnd: current.windowEnd,
      isFirstPartialWindow: firstPartialFlag(
        input.ruleActivatedAt,
        current.windowStart,
        current.windowEnd,
      ),
    };
  }

  if (input.now >= prevDeadline && input.now <= current.windowStart) {
    return {
      windowStart: previous.windowStart,
      windowEnd: previous.windowEnd,
      isFirstPartialWindow: firstPartialFlag(
        input.ruleActivatedAt,
        previous.windowStart,
        previous.windowEnd,
      ),
    };
  }

  if (input.now >= current.windowEnd && input.now < currentDeadline) {
    return {
      windowStart: current.windowStart,
      windowEnd: current.windowEnd,
      isFirstPartialWindow: firstPartialFlag(
        input.ruleActivatedAt,
        current.windowStart,
        current.windowEnd,
      ),
    };
  }

  if (input.now >= currentDeadline) {
    return {
      windowStart: current.windowStart,
      windowEnd: current.windowEnd,
      isFirstPartialWindow: firstPartialFlag(
        input.ruleActivatedAt,
        current.windowStart,
        current.windowEnd,
      ),
    };
  }

  return {
    windowStart: current.windowStart,
    windowEnd: current.windowEnd,
    isFirstPartialWindow: firstPartialFlag(
      input.ruleActivatedAt,
      current.windowStart,
      current.windowEnd,
    ),
  };
}

export function evaluationDeadline(
  windowEnd: Date,
  graceMinutes: number,
): Date {
  return new Date(windowEnd.getTime() + graceMinutes * MS_PER_MINUTE);
}

export function formatWindowEndLabel(
  windowEnd: Date,
  timezone: string,
): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return fmt.format(new Date(windowEnd.getTime() - 1));
}
