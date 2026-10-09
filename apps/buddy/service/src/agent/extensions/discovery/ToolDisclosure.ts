import type { Message } from '@earendil-works/pi-ai'
import type { ToolInfo } from '@earendil-works/pi-coding-agent'
import type { BuddyCatalogTool } from './toolCatalog'
import type { BuddyToolDisclosurePolicy, BuddyToolExposureContext, BuddyToolExposureResolver, ToolSearchInput, ToolSearchResult } from './toolDiscoveryContract'
import type { ToolDiscoveryState } from './toolDiscoveryState'
import { getCurrentSystemMessage } from '@earendil-works/pi-ai'
import MiniSearch from 'minisearch'
import { Emitter } from '../../../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../../../shared/events/eventSnapshot'
import { createToolCatalog } from './toolCatalog'
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
  readonly external: { name: string, title: string, source: string, description: string }[]
}

export class ToolDisclosure {
  readonly #changes = new Emitter<ToolDisclosureChange>(() => console.error('TOOL_DISCLOSURE_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #revision = 0
  #disposed = false
  readonly #tools: ReadonlyMap<string, BuddyCatalogTool>
  readonly #index: MiniSearch
  readonly #resolveExposure: BuddyToolExposureResolver | undefined
  #discovered = new Set<string>()

  constructor(tools: readonly ToolInfo[], baseline: readonly string[], policies: readonly BuddyToolDisclosurePolicy[], resolveExposure?: BuddyToolExposureResolver) {
    this.#tools = createToolCatalog(tools, baseline, policies)
    this.#resolveExposure = resolveExposure
    this.#index = new MiniSearch({
      idField: 'name',
      fields: ['name', 'title', 'source', 'description', 'keywords', 'fields'],
      tokenize: text => [...segmenter.segment(text.replaceAll('_', ' '))].filter(part => part.isWordLike).map(part => part.segment),
      searchOptions: { boost: { name: 5, title: 5, keywords: 3, source: 2 }, prefix: true },
    })
    this.#index.addAll([...this.#tools.values()].map(tool => ({ ...tool, fields: tool.fields.join(' '), source: `${tool.source.id} ${tool.source.title}` })))
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
    const external: ToolDisclosureResolution['external'] = []
    for (const tool of this.#tools.values()) {
      if (!this.#available(tool.name, context))
        continue
      const exposure = tool.name === TOOL_SEARCH_NAME ? 'direct' : this.#resolveExposure?.(tool, context) ?? tool.defaultExposure
      if (exposure === 'direct')
        direct.push(tool.name)
      if (exposure === 'direct' || (exposure === 'on_demand' && this.#discovered.has(tool.name)))
        active.push(tool.name)
      else if (tool.source.kind !== 'builtin')
        external.push({ name: tool.name, title: tool.title.slice(0, 160), source: tool.source.title.slice(0, 120), description: tool.description.slice(0, 180) })
    }
    const model = context.model ? Object.freeze({ provider: context.model.provider, id: context.model.id }) : null
    return { model, direct, active, external }
  }

  active(context: BuddyToolExposureContext): string[] {
    return this.resolve(context).active
  }

  search(input: ToolSearchInput, context: BuddyToolExposureContext): ToolSearchResult {
    const available = (name: string) => this.#available(name, context)
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
        name,
        id: tool.id,
        title: tool.title.slice(0, 160),
        description: tool.description.slice(0, 240),
        source: tool.source.kind === 'builtin' ? 'buddy' : `${tool.source.kind}:${tool.source.id}`,
        alreadyDisclosed: previous.has(name),
        ...(tool.defaultExposure === 'codemode' ? { invocation: 'codemode' as const } : {}),
      }
    })
    this.#replace(discovered, 'discovery')
    return {
      version: 1,
      tools,
      candidates: ranked.slice(matches.length, matches.length + 5).map(name => ({ name, description: this.#tools.get(name)!.description.slice(0, 120) })),
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
