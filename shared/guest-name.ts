/** Longest guest name, in characters. */
export const MAX_GUEST_NAME_LENGTH = 40;

/** Labels the page gives prompts that are not another guest's; a guest cannot take them. */
const RESERVED_NAMES = new Set(["host", "you"]);

/** Strips control characters and collapses whitespace. Empty means "keep the current name". */
export function normalizeGuestName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_GUEST_NAME_LENGTH)
    .trim();
}

/** The requested name, or the first free numbered variant ("Alice 2") when it is taken. */
export function uniqueGuestName(requested: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.toLowerCase()));
  const isFree = (name: string) =>
    !used.has(name.toLowerCase()) && !RESERVED_NAMES.has(name.toLowerCase());
  if (isFree(requested)) return requested;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${requested.slice(0, MAX_GUEST_NAME_LENGTH - String(suffix).length - 1)} ${suffix}`;
    if (isFree(candidate)) return candidate;
  }
}
