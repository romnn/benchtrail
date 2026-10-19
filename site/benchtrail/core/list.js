// Small operations on lists that several parts of the page share.

/**
 * @template T
 * @param {Iterable<T>} items
 * @returns {T[]}
 */
export function unique(items) {
  return [...new Set(items)];
}

/**
 * @template T, K
 * @param {Iterable<T>} items
 * @param {(item: T) => K} key
 * @returns {Map<K, number>}
 */
export function countBy(items, key) {
  /** @type {Map<K, number>} */
  const counts = new Map();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

// Orders two lists of positions element by element, with a missing position first.
/**
 * @param {readonly number[]} a
 * @param {readonly number[]} b
 */
export function compareOrder(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
}
