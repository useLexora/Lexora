export function serializeThemeRequest<Value>(input: Value): Value {
  const ancestors = new Set<object>()
  function visit(value: unknown, depth: number): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
      return value
    if (typeof value === 'number' && Number.isFinite(value))
      return value
    if (!value || typeof value !== 'object' || depth > 64 || ancestors.has(value)
      || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      throw new Error('EXTENSION_THEME_INVALID_REQUEST')
    }
    ancestors.add(value)
    const result = Array.isArray(value)
      ? Array.from(value, item => visit(item, depth + 1))
      : Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, visit(item, depth + 1)]))
    ancestors.delete(value)
    return result
  }
  return visit(input, 0) as Value
}
