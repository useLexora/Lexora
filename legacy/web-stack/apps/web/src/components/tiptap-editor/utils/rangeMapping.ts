import type { Mapping } from '@tiptap/pm/transform'

export interface TiptapRange {
  from: number
  to: number
}

export interface MapTiptapRangeOptions {
  fromAssoc?: -1 | 0 | 1
  toAssoc?: -1 | 0 | 1
  dropWhenDeletedAcross?: boolean
  allowCollapsed?: boolean
}

export function mapTiptapRange(
  range: TiptapRange,
  mapping: Mapping,
  options: MapTiptapRangeOptions = {},
): TiptapRange | null {
  const {
    fromAssoc = -1,
    toAssoc = 1,
    dropWhenDeletedAcross = true,
    allowCollapsed = true,
  } = options

  const from = mapping.mapResult(range.from, fromAssoc)
  const to = mapping.mapResult(range.to, toAssoc)

  if (dropWhenDeletedAcross && (from.deletedAcross || to.deletedAcross)) {
    return null
  }

  const mappedRange = normalizeTiptapRange({
    from: from.pos,
    to: to.pos,
  })

  if (!allowCollapsed && mappedRange.to <= mappedRange.from) {
    return null
  }

  return mappedRange
}

function normalizeTiptapRange(range: TiptapRange): TiptapRange {
  if (range.to >= range.from) {
    return range
  }

  return {
    from: range.to,
    to: range.from,
  }
}
