import { ulid } from "ulid";

/** Opaque identifier. Prefer ULID (time-sortable, opaque). */
export function createId(): string {
  return ulid();
}
