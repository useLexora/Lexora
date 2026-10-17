import { describe, expect, it } from 'vitest'
import { computeVisibleItemCount } from '../statusToolList'

describe('computeVisibleItemCount', () => {
  it('keeps every item while the list fits in the allowed rows', () => {
    expect(computeVisibleItemCount([0, 0, 24, 24], 2)).toBe(4)
  })

  it('reserves one slot for the overflow control on the last allowed row', () => {
    expect(computeVisibleItemCount([0, 0, 24, 24, 48], 2)).toBe(3)
  })

  it('keeps at least one item when only one row is allowed', () => {
    expect(computeVisibleItemCount([0, 24], 1)).toBe(1)
  })

  it('returns zero for an empty list', () => {
    expect(computeVisibleItemCount([], 2)).toBe(0)
  })
})
