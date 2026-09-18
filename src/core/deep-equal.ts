// Structural equality for frontmatter-shaped values (strings, numbers, booleans, `null`, plain
// objects, and arrays — everything YAML can produce): arrays compare order-sensitively, objects
// compare by key/value regardless of key order. Shared by `UndoManager`'s "has this changed since
// we wrote it" check and the applier's optimistic concurrency check (I5) — both need the same
// notion of "still the same value" over raw frontmatter data. No Obsidian imports.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length && aKeys.every((key) => key in b && deepEqual(a[key], b[key]))
    );
  }
  return false;
}
