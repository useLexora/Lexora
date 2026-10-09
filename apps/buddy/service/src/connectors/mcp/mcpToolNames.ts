import { createHash } from 'node:crypto'

interface McpToolNameSource {
  serverId: string
  namespace: string
  toolNames: readonly string[]
}

export class McpToolNames {
  readonly #names = new Map<string, string>()
  readonly #owners = new Map<string, string>()

  assign(sources: readonly McpToolNameSource[]): ReadonlyMap<string, ReadonlyMap<string, string>> {
    const planned = new Map<string, Set<string>>()
    for (const source of sources) {
      for (const toolName of source.toolNames) {
        const name = normalizeToolName(source.namespace, toolName)
        const owners = planned.get(name) ?? new Set<string>()
        owners.add(JSON.stringify([source.serverId, toolName]))
        planned.set(name, owners)
      }
    }
    const assigned = new Map<string, ReadonlyMap<string, string>>()
    for (const source of sources) {
      const names = new Map<string, string>()
      for (const toolName of source.toolNames) {
        const owner = JSON.stringify([source.serverId, toolName])
        const name = this.#names.get(owner) ?? createMcpToolName(source.namespace, toolName, (candidate) => {
          const existing = this.#owners.get(candidate)
          const reserved = planned.get(candidate)
          return (existing !== undefined && existing !== owner) || (reserved !== undefined && (reserved.size > 1 || !reserved.has(owner)))
        })
        this.#names.set(owner, name)
        this.#owners.set(name, owner)
        names.set(toolName, name)
      }
      assigned.set(source.serverId, names)
    }
    return assigned
  }
}

export function createMcpToolName(namespace: string, toolName: string, isTaken: (name: string) => boolean = () => false): string {
  const name = normalizeToolName(namespace, toolName)
  if (name.length <= 64 && !isTaken(name))
    return name
  for (let attempt = 0; ; attempt++) {
    const identity = attempt === 0 ? `${namespace}\0${toolName}` : `${namespace}\0${toolName}\0${attempt}`
    const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 12)
    const candidate = `${name.slice(0, 51)}_${suffix}`
    if (!isTaken(candidate))
      return candidate
  }
}

function normalizeToolName(namespace: string, toolName: string): string {
  return `mcp__${namespace}__${toolName}`.replaceAll(/\W/g, '_')
}
