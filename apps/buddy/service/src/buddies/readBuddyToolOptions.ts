import type { BuddyToolOption } from '../../../shared/buddies/buddyApi'
import type { BuddyCapabilityFactory } from '../agent/extensions/BuddyCapability'
import type { ExtensionShellRegistry } from '../sandbox/ShellSelection'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { toolCatalogId, toolCatalogPolicies } from '../agent/extensions/discovery/toolCatalog'
import { getActivePiBuiltinToolNames } from '../agent/extensions/piBuiltinTools'
import { IMAGE_READING_DISCLOSURE } from '../images/imageReadingExtension'
import { SHELL_COMMAND_DISCLOSURE } from '../sandbox/ShellSelection'

export async function readBuddyToolOptions(createCapabilities: BuddyCapabilityFactory, cwd: string, signal?: AbortSignal, shells?: Pick<ExtensionShellRegistry, 'snapshot'>): Promise<BuddyToolOption[]> {
  const lifetime = new AbortController()
  const capabilities = await createCapabilities({
    conversationId: `catalog-${randomUUID()}`,
    cwd,
    executionProfile: 'read_only',
    getRunId: () => undefined,
    grants: [],
    isCodemodeEnabled: () => true,
    sessionMode: 'interactive',
    signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
  })
  let catalog: BuddyToolOption[] = []
  const failures: unknown[] = []
  try {
    signal?.throwIfAborted()
    const snapshot = await shells?.snapshot(signal)
    const policies = [IMAGE_READING_DISCLOSURE, ...capabilities.flatMap(capability => capability.disclosure ?? []), ...snapshot?.enabled ? [SHELL_COMMAND_DISCLOSURE] : []]
    const options = toolCatalogPolicies(getActivePiBuiltinToolNames(process.platform), policies)
      .flatMap(policy => policy.tools.map(tool => ({
        id: toolCatalogId(policy.source, tool),
        name: tool.name,
        title: tool.title ?? tool.name,
        source: { ...policy.source },
      })))
    catalog = [...new Map(options.map(option => [option.id, option])).values()]
  }
  catch (error) {
    failures.push(error)
  }
  lifetime.abort()
  const results = await Promise.allSettled(capabilities.map(async capability => capability.dispose?.()))
  failures.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
  if (failures.length === 1)
    throw failures[0]
  if (failures.length)
    throw new AggregateError(failures, 'CAPABILITY_CATALOG_CLEANUP_FAILED')
  return catalog
}
