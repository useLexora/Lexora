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
    const encoder = new TextEncoder()
    let start = offset
    while (start < end) {
      let middle = start + Math.ceil((end - start) / 2)
      if (!isTextMaterialBoundary(text, middle))
        middle += 1
      const candidate = text.slice(offset, middle)
      if ((options.maxBytes === undefined || encoder.encode(candidate).byteLength <= options.maxBytes)
        && (options.maxJsonBytes === undefined || encoder.encode(JSON.stringify(candidate)).byteLength <= options.maxJsonBytes)) {
        start = middle
      }
      else {
        end = middle - 1
        if (!isTextMaterialBoundary(text, end))
          end -= 1
      }
    }
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
