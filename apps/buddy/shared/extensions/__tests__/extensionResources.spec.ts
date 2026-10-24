import { expect, it } from 'vitest'
import { extensionResourceCreateSchema } from '../extensionResources'

it.each([
  ['text/plain;charset=utf-8', 'text/plain'],
  [' Application/JSON ; charset="utf-8" ', 'application/json'],
  ['image/svg+xml; profile="a;b"', 'image/svg+xml'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
])('normalizes MIME hints to a bounded bare media type: %s', (mimeType, expected) => {
  expect(extensionResourceCreateSchema.parse({ name: 'file', size: 0, mimeType }).mimeType).toBe(expected)
})

it.each([
  '',
  'text',
  'text/plain/extra',
  'text/html,application/json',
  'text/plain; charset=utf-8\r\nInjected: value',
  'text/plain\0',
  'text/plain\u007F',
  'text/plain; charset=非ascii',
  `text/${'a'.repeat(76)}`,
  `text/plain;${'a'.repeat(1024)}`,
])('rejects unsafe or invalid MIME hints: %j', (mimeType) => {
  expect(extensionResourceCreateSchema.safeParse({ name: 'file', size: 0, mimeType }).success).toBe(false)
})

it('rejects terminal control characters before MIME normalization', () => {
  for (const mimeType of ['text/plain\n', 'text/plain\r', 'text/plain\r\n'])
    expect(extensionResourceCreateSchema.safeParse({ name: 'file', size: 0, mimeType }).success).toBe(false)
})

it('keeps the binary default when no MIME hint is supplied', () => {
  expect(extensionResourceCreateSchema.parse({ name: 'file', size: 0 }).mimeType).toBe('application/octet-stream')
})
