import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { encodeProductFrame, PRODUCT_LIMITS, productByteLength } from '../../../shared/productProtocol/limits'
import { decodeProductCursor, encodeProductCursor, encodeProductRevision } from '../../../shared/productProtocol/scalars'
import { productQueryRevision } from './ProductQueryRevisions'

export class ProductPageReader {
  readonly #database: DatabaseSync
  readonly #instance: string

  constructor(database: DatabaseSync, instance: string) {
    this.#database = database
    this.#instance = instance
  }

  read(scope: string, input: Record<string, unknown>, table: string, condition: string, params: SQLInputValue[], project: ((id: string) => unknown) | { batch: (ids: readonly string[]) => ReadonlyMap<string, unknown> }, fixedRevision?: string) {
    const revision = fixedRevision ?? productQueryRevision(this.#database, scope.split(':')[0]!, input)
    const cursorScope = createHash('sha256').update(JSON.stringify([scope, this.#instance, params.map(value => typeof value === 'bigint' ? value.toString() : value)])).digest('hex')
    let upperBound = encodeProductRevision(Number(this.#database.prepare(`SELECT COALESCE(MAX(rowid),0) AS value FROM ${table}`).get()!.value))
    let position = '0'
    if (input.cursor) {
      try {
        const cursor = decodeProductCursor(String(input.cursor), { scope: cursorScope, branchId: null, revision })
        upperBound = cursor.upperBound
        position = cursor.position
      }
      catch { throw new ProductProtocolError('CURSOR_EXPIRED') }
    }
    const rows = this.#database.prepare(`SELECT id, rowid AS position FROM ${table} WHERE (${condition}) AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`).all(...params, BigInt(position), BigInt(upperBound), Number(input.limit) + 1)
    const selected = rows.slice(0, Number(input.limit))
    const projected = typeof project === 'function' ? null : project.batch(selected.map(row => String(row.id)))
    const items: unknown[] = []
    for (const row of selected) {
      const item = typeof project === 'function' ? project(String(row.id)) : projected!.get(String(row.id)) ?? null
      if (item !== null && productByteLength(JSON.stringify([...items, item])) > PRODUCT_LIMITS.pageBytes - 4096) {
        if (!items.length)
          throw new ProductProtocolError('PAGE_TOO_LARGE')
        break
      }
      if (item !== null)
        items.push(item)
      position = encodeProductRevision(Number(row.position))
    }
    const more = rows.some(row => BigInt(Number(row.position)) > BigInt(position))
    const page = { items, nextCursor: more ? encodeProductCursor({ version: 1, scope: cursorScope, branchId: null, revision, upperBound, position }) : null }
    encodeProductFrame(page, PRODUCT_LIMITS.pageBytes)
    return page
  }
}
