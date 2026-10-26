import { Buffer } from 'node:buffer'

export const EXECUTION_RESULT_PAGE_BYTES = 32 * 1024

export function executionResultPage<T extends object>(metadata: T, report: string | null, offset = 0) {
  const totalChars = report?.length ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalChars
    || (report && offset > 0 && /[\uD800-\uDBFF]/.test(report[offset - 1]!) && /[\uDC00-\uDFFF]/.test(report[offset]!))) {
    throw new RangeError('Use a nextOffset returned by result')
  }
  const page = (end: number) => ({ ...metadata, result: report === null ? null : report.slice(offset, end), totalChars, nextOffset: end < totalChars ? end : null })
  let low = offset
  let high = totalChars
  if (Buffer.byteLength(JSON.stringify(page(low)), 'utf8') > EXECUTION_RESULT_PAGE_BYTES)
    throw new RangeError('Result metadata exceeds the page budget')
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(JSON.stringify(page(middle)), 'utf8') <= EXECUTION_RESULT_PAGE_BYTES)
      low = middle
    else high = middle - 1
  }
  if (report && low < totalChars && /[\uD800-\uDBFF]/.test(report[low - 1]!) && /[\uDC00-\uDFFF]/.test(report[low]!))
    low--
  if (report && low === offset && offset < totalChars)
    throw new RangeError('Result metadata leaves no room for content')
  return page(low)
}
