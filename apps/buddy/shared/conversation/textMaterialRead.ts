export const TEXT_MATERIAL_READ_DEFAULT_UNITS = 12000
export const TEXT_MATERIAL_READ_MAX_UNITS = 16000
export const TEXT_MATERIAL_READ_MAX_BYTES = 32 * 1024

export interface TextMaterialReadOptions {
  offset?: number
  limit?: number
  maxBytes?: number
  maxJsonBytes?: number
}

export function isTextMaterialBoundary(text: string, offset: number): boolean {
  return !(offset > 0 && offset < text.length
    && text.charCodeAt(offset - 1) >= 0xD800 && text.charCodeAt(offset - 1) <= 0xDBFF
    && text.charCodeAt(offset) >= 0xDC00 && text.charCodeAt(offset) <= 0xDFFF)
}

export function readTextMaterialPage(text: string, options: TextMaterialReadOptions = {}) {
  const offset = options.offset ?? 0
  const limit = options.limit ?? TEXT_MATERIAL_READ_DEFAULT_UNITS
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length)
    throw new Error('TEXT_READ_OFFSET_OUT_OF_RANGE')
  if (!isTextMaterialBoundary(text, offset))
    throw new Error('TEXT_READ_OFFSET_INSIDE_SURROGATE_PAIR')
  if (!Number.isSafeInteger(limit) || limit < 1
    || [options.maxBytes, options.maxJsonBytes].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 1))
    || (options.maxJsonBytes !== undefined && options.maxJsonBytes < 2)) {
    throw new Error('TEXT_READ_INVALID_LIMIT')
  }
  let end = Math.min(text.length, offset + limit)
  if (!isTextMaterialBoundary(text, end))
    end -= 1
  if (options.maxBytes !== undefined || options.maxJsonBytes !== undefined) {
    let bytes = 0
    let jsonBytes = 2
    let position = offset
    while (position < end) {
      const point = text.codePointAt(position)!
      const length = point > 0xFFFF ? 2 : 1
      const size = point <= 0x7F ? 1 : point <= 0x7FF ? 2 : point <= 0xFFFF ? 3 : 4
      const jsonSize = point < 0x20
        ? [8, 9, 10, 12, 13].includes(point) ? 2 : 6
        : point === 0x22 || point === 0x5C ? 2 : point >= 0xD800 && point <= 0xDFFF ? 6 : size
      if (bytes + size > (options.maxBytes ?? Number.MAX_SAFE_INTEGER)
        || jsonBytes + jsonSize > (options.maxJsonBytes ?? Number.MAX_SAFE_INTEGER)) {
        break
      }
      bytes += size
      jsonBytes += jsonSize
      position += length
    }
    end = position
  }
  if (end === offset && offset < text.length)
    throw new Error('TEXT_READ_LIMIT_TOO_SMALL_FOR_CHARACTER')
  return {
    text: text.slice(offset, end),
    offset,
    totalLength: text.length,
    range: { unit: 'utf16' as const, start: offset, end },
    complete: end === text.length,
    nextOffset: end < text.length ? end : null,
  }
}
