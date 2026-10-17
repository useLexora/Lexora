/**
 * Counts how many leading items fit into the allowed number of wrapped rows.
 * One slot is reserved for the overflow control so the "+N" chip never pushes a
 * visible item onto an extra row.
 */
export function computeVisibleItemCount(tops: readonly number[], maxRows: number): number {
  if (tops.length === 0)
    return 0

  const rows: number[] = []
  for (const top of tops) {
    if (!rows.some(row => Math.abs(row - top) < 1))
      rows.push(top)
  }
  if (rows.length <= maxRows)
    return tops.length

  const boundary = rows[maxRows - 1]
  if (boundary === undefined)
    return tops.length

  let fitting = 0
  for (const top of tops) {
    if (top <= boundary + 0.5)
      fitting += 1
  }
  return Math.max(1, fitting - 1)
}
