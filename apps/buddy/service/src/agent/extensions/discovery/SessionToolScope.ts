import type { BuddySettings } from '../../../../../shared/buddies/buddySettings'
import type { BuddyInProcessExtension } from '../BuddyInProcessExtension'
import type { BuddyToolWrapper } from '../changeCaptureExtension'
import type { BuddyToolDisclosurePolicy, BuddyToolSource } from './toolDiscoveryContract'
import process from 'node:process'
import { CODEMODE_TOOL_NAME } from '../codemodeExtension'
import { getActivePiBuiltinToolNames } from '../piBuiltinTools'
import { toolCatalogId, toolCatalogPolicies } from './toolCatalog'
import { TOOL_SEARCH_NAME } from './toolDiscoveryContract'

const CONTROL_TOOLS = new Set([TOOL_SEARCH_NAME, CODEMODE_TOOL_NAME, 'lexora_agents'])
const READ_ONLY_EXCLUDED_TOOLS = new Set(['write', 'edit', 'lexora_host_shell', 'lexora_authorize_directory'])

interface ScopedTool {
  readonly id: string
  readonly source: Readonly<BuddyToolSource>
}

export function getRoleToolDenial(toolName: string, tool: ScopedTool | undefined, selected: ReadonlySet<string> | null, fileAccessLimit: BuddySettings['limits']['fileAccess']): string | null {
  if (!tool || (!CONTROL_TOOLS.has(toolName) && selected && !selected.has(tool.id)))
    return 'TOOL_OUTSIDE_ROLE_SCOPE'
  if (fileAccessLimit === 'read_only' && (tool.source.kind !== 'builtin' || READ_ONLY_EXCLUDED_TOOLS.has(toolName)))
    return 'ROLE_FILE_ACCESS_READ_ONLY'
  return null
}

export class BuddyToolScopeError extends Error {
  readonly code = 'BUDDY_CAPABILITY_UNAVAILABLE'
  readonly toolIds: readonly string[]

  constructor(toolIds: readonly string[]) {
    super('BUDDY_CAPABILITY_UNAVAILABLE')
    this.name = 'BuddyToolScopeError'
    this.toolIds = [...toolIds]
  }
}

export class SessionToolScope {
  readonly #tools = new Map<string, ScopedTool>()
  readonly #selected: ReadonlySet<string> | null
  readonly #registered = new Set<string>(getActivePiBuiltinToolNames(process.platform))
  readonly #fileAccessLimit: BuddySettings['limits']['fileAccess']

  constructor(policies: readonly BuddyToolDisclosurePolicy[], selection: BuddySettings['tools'] = { mode: 'all' }, fileAccessLimit: BuddySettings['limits']['fileAccess'] = 'inherit') {
    this.#selected = selection.mode === 'all' ? null : new Set(selection.mode === 'selected' ? selection.ids : [])
    this.#fileAccessLimit = fileAccessLimit
    const ids = new Set<string>()
    for (const policy of toolCatalogPolicies([...this.#registered, TOOL_SEARCH_NAME], policies)) {
      for (const tool of policy.tools) {
        const id = toolCatalogId(policy.source, tool)
        if (this.#tools.has(tool.name) || ids.has(id))
          throw new Error('TOOL_CATALOG_DUPLICATE')
        ids.add(id)
        this.#tools.set(tool.name, { id, source: { ...policy.source } })
      }
    }
    const missing = [...this.#selected ?? []].filter(id => !ids.has(id))
    if (missing.length)
      throw new BuddyToolScopeError(missing)
  }

  denial(toolName: string): string | null {
    return getRoleToolDenial(toolName, this.#tools.get(toolName), this.#selected, this.#fileAccessLimit)
  }

  assertRegistered(toolNames: Iterable<string> = this.#registered): void {
    const names = new Set([...toolNames, TOOL_SEARCH_NAME])
    const missing = [...this.#tools].filter(([name, tool]) => this.#selected?.has(tool.id) && !names.has(name)).map(([, tool]) => tool.id)
    if (missing.length)
      throw new BuddyToolScopeError(missing)
  }

  wrap(extension: BuddyInProcessExtension, wrapTool?: BuddyToolWrapper): BuddyInProcessExtension {
    return {
      ...extension,
      factory: pi => extension.factory({
        ...pi,
        registerTool: (tool) => {
          this.#registered.add(tool.name)
          const scoped = this.denial(tool.name) ? { ...tool, exposure: 'hidden' as const } : tool
          pi.registerTool(wrapTool ? wrapTool(scoped) : scoped)
        },
      }),
    }
  }
}
