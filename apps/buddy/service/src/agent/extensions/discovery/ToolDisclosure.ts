import type { Message } from '@earendil-works/pi-ai'
import type { ToolInfo } from '@earendil-works/pi-coding-agent'
import type { SessionToolScope } from './SessionToolScope'
import type { BuddyCatalogTool } from './toolCatalog'
import type { BuddyToolDisclosurePolicy, BuddyToolExposureContext, BuddyToolExposureResolver, BuddyToolGroupSummary, BuddyToolSearchCandidate, ToolSearchInput, ToolSearchResult } from './toolDiscoveryContract'
import type { ToolDiscoveryState } from './toolDiscoveryState'
import { getCurrentSystemMessage } from '@earendil-works/pi-ai'
import MiniSearch from 'minisearch'
import { Emitter } from '../../../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../../../shared/events/eventSnapshot'
import { isPiShellToolName } from '../piBuiltinTools'
import { createToolCatalog, parameterFields } from './toolCatalog'
import { isToolSearchResult, TOOL_SEARCH_NAME } from './toolDiscoveryContract'

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

export interface ToolDisclosureChange {
  readonly revision: number
  readonly reason: 'discovery' | 'restore'
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly discovered: readonly string[]
}

export interface ToolDisclosureResolution {
  readonly model: { readonly provider: string, readonly id: string } | null
  readonly direct: string[]
  readonly active: string[]
  readonly catalog: BuddyToolDirectory
}

export interface BuddyToolDirectory {
  readonly groups: readonly BuddyToolGroupSummary[]
  readonly tools: readonly BuddyToolSearchCandidate[]
}

function sourceId(tool: BuddyCatalogTool): string {
  return `${tool.source.kind}:${tool.source.id}`
}

function groupSource(tool: BuddyCatalogTool): string {
  return tool.source.kind === 'builtin' ? 'builtin' : sourceId(tool)
}

function searchDocument(tool: BuddyCatalogTool) {
  return { ...tool, namespace: tool.namespace ? `${tool.namespace.name} ${tool.namespace.description ?? ''}` : '', fields: tool.fields.join(' '), source: `${tool.source.id} ${tool.source.title}` }
}

function candidate(tool: BuddyCatalogTool): BuddyToolSearchCandidate {
  return {
    name: tool.name,
    description: tool.description.slice(0, 240),
    source: sourceId(tool),
    ...(tool.namespace ? { namespace: tool.namespace.name } : {}),
  }
}

function groupSummaries(tools: readonly BuddyCatalogTool[]): BuddyToolGroupSummary[] {
  const groups = new Map<string, BuddyToolGroupSummary>()
  for (const tool of tools) {
    if (!tool.namespace)
      continue
    const source = groupSource(tool)
    const key = JSON.stringify([source, tool.namespace.name])
    const group = groups.get(key)
    if (group) {
      group.toolCount++
      if (group.examples && group.examples.length < 2)
        group.examples = [...group.examples, tool.description.slice(0, 120)]
    }
    else {
      groups.set(key, { namespace: tool.namespace.name, source, description: (tool.namespace.description ?? tool.source.title).slice(0, 240), toolCount: 1, ...(tool.source.kind !== 'builtin' ? { examples: [tool.description.slice(0, 120)] } : {}) })
    }
  }
  return [...groups.values()].sort((a, b) => a.namespace.localeCompare(b.namespace, 'en') || a.source.localeCompare(b.source, 'en'))
}

export class ToolDisclosure {
  readonly #changes = new Emitter<ToolDisclosureChange>(() => console.error('TOOL_DISCLOSURE_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #revision = 0
  #disposed = false
  readonly #tools: Map<string, BuddyCatalogTool>
  readonly #index: MiniSearch
  readonly #resolveExposure: BuddyToolExposureResolver | undefined
  #discovered = new Set<string>()

  constructor(tools: readonly ToolInfo[], baseline: readonly string[], policies: readonly BuddyToolDisclosurePolicy[], resolveExposure?: BuddyToolExposureResolver, scope?: SessionToolScope) {
    scope?.assertRegistered(tools.map(tool => tool.name))
    const unifiedShell = tools.some(tool => tool.name === 'lexora_shell') && !scope?.denial('lexora_shell')
    this.#tools = new Map([...createToolCatalog(tools, baseline, policies)].filter(([name]) => !scope?.denial(name) && !(unifiedShell && isPiShellToolName(name))))
    this.#resolveExposure = resolveExposure
    this.#index = new MiniSearch({
      idField: 'name',
      fields: ['name', 'title', 'source', 'namespace', 'description', 'keywords', 'fields'],
      tokenize: text => [...segmenter.segment(text.replaceAll('_', ' '))].filter(part => part.isWordLike).map(part => part.segment),
      searchOptions: { boost: { name: 5, title: 5, keywords: 3, source: 2 }, prefix: true },
    })
    this.#index.addAll([...this.#tools.values()].map(searchDocument))
  }

  refreshDefinitions(definitions: readonly ToolInfo[]): void {
    for (const definition of definitions) {
      const previous = this.#tools.get(definition.name)
      if (!previous)
        continue
      const fields = parameterFields(definition.parameters)
      if (previous.description === definition.description && JSON.stringify(previous.fields) === JSON.stringify(fields) && JSON.stringify(previous.namespace) === JSON.stringify(definition.namespace))
        continue
      const updated = copyEventSnapshot({ ...previous, description: definition.description, fields, namespace: definition.namespace })
      this.#tools.set(definition.name, updated)
      this.#index.replace(searchDocument(updated))
    }
  }

  get snapshot() { return Object.freeze({ revision: this.#revision, discovered: Object.freeze([...this.#discovered]) }) }

  get persistedState(): ToolDiscoveryState {
    return { version: 1, discovered: [...this.#discovered].map(name => this.#tools.get(name)!.id) }
  }

  dispose(): void {
    this.#disposed = true
    this.#changes.dispose()
  }

  resolve(context: BuddyToolExposureContext): ToolDisclosureResolution {
    const direct: string[] = []
    const active: string[] = []
    const deferred: BuddyCatalogTool[] = []
    for (const tool of this.#tools.values()) {
      if (!this.#available(tool.name, context))
        continue
      const exposure = tool.name === TOOL_SEARCH_NAME ? 'direct' : this.#resolveExposure?.(tool, context) ?? tool.defaultExposure
      if (exposure === 'direct')
        direct.push(tool.name)
      if (exposure === 'direct' || (exposure === 'on_demand' && this.#discovered.has(tool.name)))
        active.push(tool.name)
      else
        deferred.push(tool)
    }
    const model = context.model ? Object.freeze({ provider: context.model.provider, id: context.model.id }) : null
    return { model, direct, active, catalog: { groups: groupSummaries(deferred), tools: deferred.filter(tool => !tool.namespace).map(candidate) } }
  }

  active(context: BuddyToolExposureContext): string[] {
    return this.resolve(context).active
  }

  search(input: ToolSearchInput, context: BuddyToolExposureContext): ToolSearchResult {
    const available = (name: string) => {
      const tool = this.#tools.get(name)
      return !!tool && this.#available(name, context)
        && (input.namespace === undefined || tool.namespace?.name === input.namespace)
        && (input.source === undefined || input.source === sourceId(tool) || input.source === groupSource(tool))
    }
    if (input.query === undefined && input.toolNames === undefined) {
      const availableTools = [...this.#tools.values()].filter(tool => available(tool.name))
      const groups = groupSummaries(availableTools)
      const offset = input.offset ?? 0
      const limit = input.limit ?? 5
      const entries = input.namespace ? availableTools : groups
      return {
        version: 1,
        tools: [],
        candidates: input.namespace ? availableTools.slice(offset, offset + limit).map(candidate) : [],
        groups: input.namespace ? groups : groups.slice(offset, offset + limit),
        notFound: [],
        ...(offset + limit < entries.length ? { nextOffset: offset + limit } : {}),
      }
    }
    const requested = [...new Set((input.toolNames ?? []).map(name => this.#canonicalName(name)))]
    const query = this.#canonicalName(input.query?.trim() ?? '')
    const exact = available(query) ? [query] : []
    const ranked = requested.length > 0
      ? requested.filter(available)
      : exact.length > 0
        ? exact
        : this.#index.search(query, { filter: match => available(String(match.id)) })
            .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id), 'en'))
            .map(match => String(match.id))
    const matches = ranked.slice(0, requested.length > 0 ? 5 : input.limit ?? 3)
    const previous = new Set(this.active(context))
    const discovered = new Set(this.#discovered)
    const tools = matches.map((name) => {
      const tool = this.#tools.get(name)!
      discovered.add(name)
      return {
        id: tool.id,
        title: tool.title.slice(0, 160),
        ...candidate(tool),
        source: sourceId(tool),
        alreadyDisclosed: previous.has(name),
        ...((this.#resolveExposure?.(tool, context) ?? tool.defaultExposure) === 'codemode' ? { invocation: 'codemode' as const } : {}),
      }
    })
    this.#replace(discovered, 'discovery')
    return {
      version: 1,
      tools,
      candidates: ranked.slice(matches.length, matches.length + 5).map(name => candidate(this.#tools.get(name)!)),
      notFound: (input.toolNames ?? []).filter(name => !available(this.#canonicalName(name))),
    }
  }

  restore(messages: readonly Message[], state?: ToolDiscoveryState): void {
    if (state) {
      const ids = new Set(state.discovered)
      this.#replace(new Set([...this.#tools.values()].filter(tool => ids.has(tool.id)).map(tool => tool.name)), 'restore')
      return
    }
    const current = getCurrentSystemMessage(messages)
    if (current) {
      this.#replace(new Set((current.toolsAdded ?? []).map(tool => this.#canonicalName(tool.name)).filter(name => this.#tools.has(name))), 'restore')
      return
    }
    const discovered = new Set<string>()
    const calls = new Map<string, string>()
    for (const message of messages) {
      if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'toolCall')
            calls.set(block.id, block.name)
        }
      }
      if (message.role !== 'toolResult' || message.isError || calls.get(message.toolCallId) !== message.toolName)
        continue
      if (message.toolName === TOOL_SEARCH_NAME) {
        for (const block of message.content) {
          if (block.type !== 'text')
            continue
          try {
            const result: unknown = JSON.parse(block.text)
            if (isToolSearchResult(result)) {
              for (const tool of result.tools) {
                const name = this.#canonicalName(tool.name)
                if (tool.id === undefined || this.#tools.get(name)?.id === tool.id)
                  discovered.add(name)
              }
            }
          }
          catch {}
        }
      }
      else {
        discovered.add(this.#canonicalName(message.toolName))
      }
    }
    this.#replace(new Set([...discovered].filter(name => this.#tools.has(name))), 'restore')
  }

  #replace(next: Set<string>, reason: ToolDisclosureChange['reason']): void {
    if (this.#disposed)
      throw new Error('TOOL_DISCLOSURE_DISPOSED')
    const added = [...next].filter(name => !this.#discovered.has(name))
    const removed = [...this.#discovered].filter(name => !next.has(name))
    if (!added.length && !removed.length)
      return
    this.#discovered = new Set([...next].sort())
    this.#changes.fire(copyEventSnapshot({ revision: ++this.#revision, reason, added, removed, discovered: [...this.#discovered] }))
  }

  #available(name: string, context: BuddyToolExposureContext): boolean {
    const tool = this.#tools.get(name)
    return !!tool && (this.#resolveExposure?.(tool, context) ?? tool.defaultExposure) !== 'hidden' && (tool.available?.(context, name) ?? true)
  }

  #canonicalName(name: string): string {
    if (this.#tools.has(name))
      return name
    return [...this.#tools.values()].find(tool => tool.aliases?.includes(name))?.name ?? name
  }
}
