import type { ReadonlyJsonArray, ReadonlyJsonValue } from '../workbench/workbenchState'
import { z } from 'zod'
import { copyEventSnapshot } from '../events/eventSnapshot.ts'

function isJsonArray(value: ReadonlyJsonValue): value is ReadonlyJsonArray {
  return Array.isArray(value)
}

export function sameReferenceJson(left: ReadonlyJsonValue | undefined, right: ReadonlyJsonValue | undefined): boolean {
  if (left === right)
    return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object')
    return false
  if (isJsonArray(left) || isJsonArray(right))
    return isJsonArray(left) && isJsonArray(right) && left.length === right.length && left.every((value, index) => sameReferenceJson(value, right[index]))
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameReferenceJson(left[key], right[key]))
}

function isReferenceJson(value: unknown): value is ReadonlyJsonValue {
  const pending = [{ value, depth: 0 }]
  const visited = new Set<object>()
  let count = 0
  try {
    while (pending.length) {
      const item = pending.pop()!
      if (++count > 1024 || item.depth > 12)
        return false
      const current = item.value
      if (current === null || typeof current === 'boolean')
        continue
      if (typeof current === 'string') {
        if (current.length > 8192)
          return false
        continue
      }
      if (typeof current === 'number') {
        if (!Number.isFinite(current))
          return false
        continue
      }
      if (typeof current !== 'object' || visited.has(current))
        return false
      visited.add(current)
      const array = Array.isArray(current)
      if (!array && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null)
        return false
      const descriptors = Object.getOwnPropertyDescriptors(current)
      if (Reflect.ownKeys(current).some(key => typeof key !== 'string'))
        return false
      const keys = Object.keys(descriptors).filter(key => !array || key !== 'length')
      if (keys.length > 256 || (array && keys.length !== current.length))
        return false
      for (const key of keys) {
        const descriptor = descriptors[key]!
        if (key.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(key) || !descriptor.enumerable || !('value' in descriptor))
          return false
        if (array && !/^(?:0|[1-9]\d*)$/.test(key))
          return false
        pending.push({ value: descriptor.value, depth: item.depth + 1 })
      }
    }
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16384
  }
  catch {
    return false
  }
}

export const referenceJsonSchema = z.custom<ReadonlyJsonValue>(isReferenceJson, 'Expected bounded plain JSON').transform((value): ReadonlyJsonValue => copyEventSnapshot(value))
export const referenceLocatorSchema = z.object({
  version: z.number().int().min(1).max(10000),
  data: referenceJsonSchema,
}).strict().readonly()
export type ReferenceLocator = z.infer<typeof referenceLocatorSchema>

export const referenceViewSourceSchema = z.object({
  kind: z.literal('view'),
  title: z.string().trim().min(1).max(512),
  provider: z.string().min(1).max(180).regex(/^[a-z][a-z0-9.:_-]*$/),
  target: referenceJsonSchema,
}).strict().readonly()
export type ReferenceViewSource = z.infer<typeof referenceViewSourceSchema>
