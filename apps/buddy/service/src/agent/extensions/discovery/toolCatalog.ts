import type { ToolInfo } from '@earendil-works/pi-coding-agent'
import type { BuddyToolDisclosurePolicy, BuddyToolMetadata } from './toolDiscoveryContract'
import { copyEventSnapshot } from '../../../../../shared/events/eventSnapshot'
import { PI_BUILTIN_TOOL_NAME_SET } from '../piBuiltinTools'
import { TOOL_SEARCH_NAME } from './toolDiscoveryContract'

export interface BuddyCatalogTool extends BuddyToolMetadata {
  readonly description: string
  readonly keywords: string
  readonly fields: readonly string[]
  readonly available: BuddyToolDisclosurePolicy['available']
}

export function createToolCatalog(tools: readonly ToolInfo[], baseline: readonly string[], policies: readonly BuddyToolDisclosurePolicy[]): ReadonlyMap<string, BuddyCatalogTool> {
  const definitions = new Map(tools.map(tool => [tool.name, tool]))
  const catalog = new Map<string, BuddyCatalogTool>()
  const declared: BuddyToolDisclosurePolicy[] = [{
    source: { kind: 'builtin', id: 'core', title: 'Files, shell and tool discovery' },
    exposure: 'direct',
    keywords: '',
    tools: baseline.filter(name => PI_BUILTIN_TOOL_NAME_SET.has(name) || name === TOOL_SEARCH_NAME).map(name => ({ name })),
  }, ...policies]
  const identities = new Set<string>()
  for (const policy of declared) {
    for (const entry of policy.tools) {
      const definition = definitions.get(entry.name)
      if (!definition)
        continue
      const id = JSON.stringify([policy.source.kind, policy.source.id, entry.id ?? entry.name])
      if (catalog.has(entry.name) || identities.has(id))
        throw new Error('TOOL_CATALOG_DUPLICATE')
      identities.add(id)
      catalog.set(entry.name, copyEventSnapshot({
        id,
        name: entry.name,
        aliases: entry.aliases,
        title: entry.title ?? entry.name,
        source: policy.source,
        defaultExposure: policy.exposure,
        description: definition.description,
        keywords: policy.keywords,
        fields: parameterFields(definition.parameters),
        available: policy.available,
      }))
    }
  }
  return new Map([...catalog].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}

function parameterFields(value: unknown, depth = 0): string[] {
  if (!value || typeof value !== 'object' || depth > 12)
    return []
  if (Array.isArray(value))
    return value.flatMap(item => parameterFields(item, depth + 1))
  const schema = value as Record<string, unknown>
  const properties = schema.properties
  return [
    ...(properties && typeof properties === 'object' ? Object.keys(properties) : []),
    ...Object.values(schema).flatMap(item => parameterFields(item, depth + 1)),
  ]
}
