const keywords = new Set([
  '$schema',
  '$defs',
  '$ref',
  'type',
  'anyOf',
  'oneOf',
  'allOf',
  'const',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'items',
  'minLength',
  'maxLength',
  'pattern',
  'x-pattern-flags',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'readOnly',
  'default',
  'description',
  'title',
])

export function assertMobileSchema(schema, path = '#') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    throw new Error(`Unsupported mobile schema at ${path}`)
  for (const key of Object.keys(schema)) {
    if (!keywords.has(key))
      throw new Error(`Unsupported mobile schema keyword at ${path}/${key}`)
  }
  if (schema.format !== undefined && schema.format !== 'date-time')
    throw new Error(`Unsupported mobile schema format at ${path}/format: ${schema.format}`)
  if (schema.$ref !== undefined && !schema.$ref.startsWith('#/'))
    throw new Error(`Unsupported mobile schema reference at ${path}/$ref`)
  for (const key of ['properties', '$defs']) {
    for (const [name, child] of Object.entries(schema[key] ?? {}))
      assertMobileSchema(child, `${path}/${key}/${name}`)
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    for (const [index, child] of (schema[key] ?? []).entries())
      assertMobileSchema(child, `${path}/${key}/${index}`)
  }
  for (const key of ['items', 'propertyNames', 'additionalProperties']) {
    if (schema[key] !== undefined && !(key === 'additionalProperties' && typeof schema[key] === 'boolean'))
      assertMobileSchema(schema[key], `${path}/${key}`)
  }
}
