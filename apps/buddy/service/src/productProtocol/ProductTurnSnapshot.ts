import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { PRODUCT_LIMITS, productByteLength } from '../../../shared/productProtocol/limits'

export function createProductTurnSnapshot(items: Generator<unknown>) {
  let pending = items.next()
  let expected: string | null = null
  let page = 0
  return (cursor: string | null) => {
    if (cursor !== expected || (page > 0 && expected === null))
      throw new ProductProtocolError('CURSOR_EXPIRED')
    const values: unknown[] = []
    let bytes = 0
    while (!pending.done && values.length < PRODUCT_LIMITS.pageItems) {
      const size = productByteLength(JSON.stringify(pending.value)) + 1
      if (bytes + size > PRODUCT_LIMITS.pageBytes - 4096) {
        if (!values.length)
          throw new ProductProtocolError('PAGE_TOO_LARGE')
        break
      }
      values.push(pending.value)
      bytes += size
      pending = items.next()
    }
    page++
    expected = pending.done ? null : String(page)
    return { items: values, nextCursor: expected }
  }
}
