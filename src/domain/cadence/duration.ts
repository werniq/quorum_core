/** Parse a positive duration expressed as minutes or a unit suffix. */
export function parsePositiveDurationMinutes(
  cadenceValue: string,
): number | null {
  const trimmed = cadenceValue.trim();
  if (/^\d+$/.test(trimmed)) {
    const minutes = Number(trimmed);
    return minutes > 0 ? minutes : null;
  }
  const match = /^(\d+)\s*(m|min|minutes|h|hr|hours|d|day|days)$/i.exec(
    trimmed,
  );
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const unit = match[2]!.toLowerCase();
  if (unit.startsWith("m")) {
    return amount;
  }
  if (unit.startsWith("h")) {
    return amount * 60;
  }
  return amount * 60 * 24;
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}
