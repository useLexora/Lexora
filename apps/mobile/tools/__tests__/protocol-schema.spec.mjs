import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertMobileSchema } from '../protocol-schema.mjs'

test('mobile schema export rejects unsupported nested validation keywords', () => {
  assert.throws(() => assertMobileSchema({ type: 'object', properties: { list: { type: 'array', uniqueItems: true } } }), /properties\/list\/uniqueItems/)
  assert.throws(() => assertMobileSchema({ type: 'string', format: 'email' }), /format/)
  assert.doesNotThrow(() => assertMobileSchema({ type: 'object', additionalProperties: { type: 'number', exclusiveMinimum: 0 }, propertyNames: { type: 'string', minLength: 1 } }))
})
