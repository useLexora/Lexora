import type { EventSnapshot } from './eventTypes'

export function freezeEventSnapshot<Value>(value: Value): EventSnapshot<Value> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeEventSnapshot(child)
    Object.freeze(value)
  }
  return value as EventSnapshot<Value>
}

export function copyEventSnapshot<Value>(value: Value): EventSnapshot<Value> {
  const copies = new WeakMap<object, object>()
  const copy = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object')
      return input
    const existing = copies.get(input)
    if (existing)
      return existing
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      throw new TypeError('EVENT_SNAPSHOT_REQUIRES_PLAIN_DATA')
    const output: Record<string, unknown> | unknown[] = Array.isArray(input) ? [] : Object.create(null)
    copies.set(input, output)
    for (const [key, child] of Object.entries(input))
      Object.defineProperty(output, key, { value: copy(child), enumerable: true, configurable: true, writable: true })
    return Object.freeze(output)
  }
  return copy(value) as EventSnapshot<Value>
}
