import type { ToolNamespace } from '@earendil-works/pi-coding-agent'

export interface BuddyToolGroup {
  readonly name: string
  readonly description?: string
  readonly tools: readonly { readonly name: string }[]
}

export function toPiToolGroup<const Group extends BuddyToolGroup, const Names extends Partial<Record<Group['tools'][number]['name'], string>> = Record<never, never>>(
  group: Group,
  names?: Names,
): {
  readonly [Tool in Group['tools'][number] as Tool['name']]: Omit<Tool, 'name' | 'namespace'> & {
    readonly name: Names[Tool['name']] extends string ? Names[Tool['name']] : `${Group['name']}_${Tool['name']}`
    readonly namespace: Readonly<ToolNamespace>
  }
}
export function toPiToolGroup(group: BuddyToolGroup, names: Record<string, string> = {}): Readonly<Record<string, { readonly name: string, readonly namespace: Readonly<ToolNamespace> }>> {
  const namespace = Object.freeze({ name: group.name, description: group.description })
  const registered = new Set<string>()
  const definitions = new Set<string>()
  return Object.freeze(Object.fromEntries(group.tools.map((tool) => {
    const name = Object.hasOwn(names, tool.name) ? names[tool.name]! : `${group.name}_${tool.name}`
    if (!/^[\w-]+$/.test(group.name) || !/^[\w-]+$/.test(tool.name) || !/^[\w-]{1,64}$/.test(name))
      throw new Error('TOOL_GROUP_INVALID_NAME')
    if (definitions.has(tool.name) || registered.has(name))
      throw new Error('TOOL_GROUP_DUPLICATE')
    definitions.add(tool.name)
    registered.add(name)
    return [tool.name, Object.freeze({ ...tool, name, namespace })]
  })))
}
