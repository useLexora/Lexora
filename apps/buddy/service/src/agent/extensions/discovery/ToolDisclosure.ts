import type { Api, Message, Model } from '@earendil-works/pi-ai'
import type { ToolInfo } from '@earendil-works/pi-coding-agent'
import type { BuddyToolDisclosurePolicy, ToolSearchInput, ToolSearchResult } from './toolDiscoveryContract'
import { getCurrentSystemMessage } from '@earendil-works/pi-ai'
import MiniSearch from 'minisearch'
import { Emitter } from '../../../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../../../shared/events/eventSnapshot'
import { isToolSearchResult, TOOL_SEARCH_NAME } from './toolDiscoveryContract'

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

export interface ToolDisclosureChange {
  readonly revision: number
  readonly reason: 'discovery' | 'restore'
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly discovered: readonly string[]
}

export class ToolDisclosure {
  readonly #changes = new Emitter<ToolDisclosureChange>(() => console.error('TOOL_DISCLOSURE_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #revision = 0
  #disposed = false
  readonly #policies: ReadonlyMap<string, BuddyToolDisclosurePolicy>
  readonly #tools: ReadonlyMap<string, Readonly<Pick<ToolInfo, 'name' | 'description'>>>
  readonly #index: MiniSearch
  readonly #resident: readonly string[]
  #discovered = new Set<string>()

  constructor(tools: readonly ToolInfo[], resident: readonly string[], policies: readonly BuddyToolDisclosurePolicy[]) {
    this.#tools = new Map(tools.map(tool => [tool.name, Object.freeze({ name: tool.name, description: tool.description })]))
    this.#policies = new Map(policies.flatMap((policy) => {
      const owned = copyEventSnapshot(policy)
      return owned.toolNames.map(name => [name, owned] as const)
    }))
    this.#resident = Object.freeze([...new Set(resident.filter(name => !this.#policies.has(name)))])
    this.#index = new MiniSearch({
      idField: 'name',
      fields: ['name', 'description', 'keywords', 'fields'],
      tokenize: text => [...segmenter.segment(text.replaceAll('_', ' '))].filter(part => part.isWordLike).map(part => part.segment),
      searchOptions: { boost: { name: 5, keywords: 3 }, prefix: true },
    })
    this.#index.addAll(tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      keywords: this.#policies.get(tool.name)?.keywords ?? '',
      fields: parameterFields(tool.parameters).join(' '),
    })))
  }

  get snapshot() { return Object.freeze({ revision: this.#revision, discovered: Object.freeze([...this.#discovered]) }) }

  dispose(): void {
    this.#disposed = true
    this.#changes.dispose()
  }

  active(model: Model<Api> | undefined): string[] {
    return [...this.#resident, ...this.#discovered].filter(name => this.#available(name, model))
  }

  connectedTools(model: Model<Api> | undefined): { name: string, description: string }[] {
    return [...this.#tools.values()]
      .filter(tool => this.#policies.get(tool.name)?.group === 'mcp' && this.#available(tool.name, model))
      .map(tool => ({ name: tool.name, description: tool.description.slice(0, 180) }))
  }

  search(input: ToolSearchInput, model: Model<Api> | undefined): ToolSearchResult {
    const available = (name: string) => this.#available(name, model)
    const requested = input.toolNames ?? []
    const query = input.query?.trim() ?? ''
    const exact = available(query) ? [query] : []
    const ranked = requested.length > 0
      ? requested.filter(available)
      : exact.length > 0
        ? exact
        : this.#index.search(query, { filter: match => available(String(match.id)) }).map(match => String(match.id))
    const matches = ranked.slice(0, requested.length > 0 ? 5 : input.limit ?? 3)
    const previous = new Set(this.active(model))
    const discovered = new Set(this.#discovered)
    const tools = matches.flatMap((name) => {
      const tool = this.#tools.get(name)
      if (!tool)
        return []
      if (!this.#resident.includes(name))
        discovered.add(name)
      return [{
        name,
        description: tool.description.slice(0, 240),
        source: name.startsWith('mcp__') ? name.split('__').slice(0, 2).join('__') : 'buddy',
        alreadyDisclosed: previous.has(name),
      }]
    })
    this.#replace(discovered, 'discovery')
    return {
      version: 1,
      tools,
      candidates: ranked.slice(matches.length, matches.length + 5).map(name => ({ name, description: this.#tools.get(name)!.description.slice(0, 120) })),
      notFound: requested.filter(name => !available(name)),
    }
  }

  restore(messages: readonly Message[]): void {
    const current = getCurrentSystemMessage(messages)
    if (current) {
      this.#replace(new Set((current.toolsAdded ?? []).map(tool => tool.name).filter(name => this.#policies.has(name))), 'restore')
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
              for (const tool of result.tools)
                discovered.add(tool.name)
            }
          }
          catch {}
        }
      }
      else {
        discovered.add(message.toolName)
      }
    }
    this.#replace(new Set([...discovered].filter(name => this.#policies.has(name))), 'restore')
  }

  #replace(next: Set<string>, reason: ToolDisclosureChange['reason']): void {
    if (this.#disposed)
      throw new Error('TOOL_DISCLOSURE_DISPOSED')
    const added = [...next].filter(name => !this.#discovered.has(name))
    const removed = [...this.#discovered].filter(name => !next.has(name))
    if (!added.length && !removed.length)
      return
    this.#discovered = next
    this.#changes.fire(copyEventSnapshot({ revision: ++this.#revision, reason, added, removed, discovered: [...next] }))
  }

  #available(name: string, model: Model<Api> | undefined): boolean {
    return this.#tools.has(name)
      && (this.#resident.includes(name) || this.#policies.has(name))
      && (this.#policies.get(name)?.available?.(model, name) ?? true)
  }
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
