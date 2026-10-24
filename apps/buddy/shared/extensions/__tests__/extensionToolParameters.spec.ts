import { Check } from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { extensionToolSchema } from '../../../service/src/plugins/extensionToolSchema'
import { extensionToolInputSchema, extensionToolParametersSchema } from '../extensionToolParameters'

const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
describe('bounded extension tool schemas', () => {
  it('accepts legacy primitives and validates nested operations through the actual Pi schema', () => {
    const parsed = extensionToolParametersSchema.parse(object({ operation: { type: 'string', enum: ['insert', 'remove'] }, items: { type: 'array', maxItems: 2, items: object({ position: { type: 'number', minimum: 0 }, text: { type: 'string', maxLength: 4 } }) } }))
    const schema = extensionToolSchema(parsed)
    expect(Check(schema, { operation: 'insert', items: [{ position: 0, text: 'test' }] })).toBe(true)
    for (const input of [
      { operation: 'unknown', items: [] },
      { operation: 'insert', items: [{ position: -1, text: 'test' }] },
      { operation: 'insert', items: [{ position: 0, text: 'oversized' }] },
      { operation: 'insert', items: [{ position: 0, text: 'ok', extra: true }] },
      { operation: 'insert', items: [{ position: 0, text: 'a' }, { position: 1, text: 'b' }, { position: 2, text: 'c' }] },
    ]) expect(Check(schema, input)).toBe(false)
    expect(extensionToolParametersSchema.parse(object({ name: { type: 'string' }, count: { type: 'number' }, enabled: { type: 'boolean' } })).properties.name).toEqual({ type: 'string' })
  })

  it('rejects deep, broad, external and unbounded schemas before registration', () => {
    let deep: unknown = { type: 'string' }
    for (let i = 0; i < 5; i++) deep = { type: 'array', items: deep }
    for (const schema of [object({ nested: deep }), object({ data: { type: 'object', properties: {}, additionalProperties: true } }), object({ data: { $ref: 'file:///private' } }), object({ data: { type: 'array', items: { type: 'string' }, maxItems: 257 } }), object(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`field${i}`, { type: 'string' }]))), object(Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`field${i}`, object(Object.fromEntries(Array.from({ length: 16 }, (_, j) => [`value${j}`, { type: 'string' }])))])))])
      expect(extensionToolParametersSchema.safeParse(schema).success).toBe(false)
  })

  it('bounds the actual input independently of its declared schema', () => {
    expect(extensionToolInputSchema.safeParse({ input: { cells: [[1, 'two', true, null]] } }).success).toBe(true)
    expect(extensionToolInputSchema.safeParse({ data: Array.from({ length: 9 }, () => 'x'.repeat(32768)) }).success).toBe(false)
    expect(extensionToolInputSchema.safeParse({ data: Array.from({ length: 257 }).fill(0) }).success).toBe(false)
    expect(extensionToolInputSchema.safeParse({ data: Number.POSITIVE_INFINITY }).success).toBe(false)
  })
})
