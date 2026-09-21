import type { Api, Message, Model } from '@earendil-works/pi-ai'
import type { ToolInfo } from '@earendil-works/pi-coding-agent'
import type { BuddyToolDisclosurePolicy, ToolSearchInput, ToolSearchResult } from './toolDiscoveryContract'
import { getCurrentSystemMessage } from '@earendil-works/pi-ai'
import MiniSearch from 'minisearch'
import { isToolSearchResult, TOOL_SEARCH_NAME } from './toolDiscoveryContract'

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

export class ToolDisclosure {
  readonly #policies: ReadonlyMap<string, BuddyToolDisclosurePolicy>
  readonly #tools: ReadonlyMap<string, ToolInfo>
  readonly #index: MiniSearch
  readonly #resident: readonly string[]
  #discovered = new Set<string>()

  constructor(tools: readonly ToolInfo[], resident: readonly string[], policies: readonly BuddyToolDisclosurePolicy[]) {
    this.#tools = new Map(tools.map(tool => [tool.name, tool]))
    this.#policies = new Map(policies.flatMap(policy => policy.toolNames.map(name => [name, policy] as const)))
    this.#resident = resident.filter(name => !this.#policies.has(name))
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
    const tools = matches.flatMap((name) => {
      const tool = this.#tools.get(name)
      if (!tool)
        return []
      if (!this.#resident.includes(name))
        this.#discovered.add(name)
      return [{
        name,
        description: tool.description.slice(0, 240),
        source: name.startsWith('mcp__') ? name.split('__').slice(0, 2).join('__') : 'buddy',
        alreadyDisclosed: previous.has(name),
      }]
    })
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
      this.#discovered = new Set((current.toolsAdded ?? []).map(tool => tool.name).filter(name => this.#policies.has(name)))
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
    this.#discovered = new Set([...discovered].filter(name => this.#policies.has(name)))
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
