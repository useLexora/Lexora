import type { Api, Model } from '@earendil-works/pi-ai'
import type { ToolNamespace } from '@earendil-works/pi-coding-agent'
import type { Static } from 'typebox'
import { Type } from 'typebox'

export const TOOL_SEARCH_NAME = 'lexora_tool_search'

export type BuddyToolExposure = 'direct' | 'on_demand' | 'codemode' | 'hidden'

export interface BuddyToolSource {
  kind: 'builtin' | 'mcp' | 'plugin'
  id: string
  title: string
}

export interface BuddyToolExposureContext {
  model: Model<Api> | undefined
}

export interface BuddyToolMetadata {
  readonly id: string
  readonly name: string
  readonly aliases?: readonly string[]
  readonly title: string
  readonly source: Readonly<BuddyToolSource>
  readonly namespace?: Readonly<ToolNamespace>
  readonly defaultExposure: BuddyToolExposure
}

export type BuddyToolExposureResolver = (tool: BuddyToolMetadata, context: BuddyToolExposureContext) => BuddyToolExposure | undefined

export interface BuddyToolDisclosurePolicy {
  source: BuddyToolSource
  exposure: BuddyToolExposure
  keywords: string
  tools: readonly { name: string, id?: string, title?: string, aliases?: readonly string[] }[]
  available?: (context: BuddyToolExposureContext, toolName: string) => boolean
}

export const toolSearchParameters = Type.Object({
  namespace: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: 'Filter by exact namespace. Alone, lists members without loading them.' })),
  source: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: 'Optional source from the catalog, such as builtin or mcp:connector-id.' })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Pagination offset when listing namespaces or their members; never used with query or toolNames.' })),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: 'Natural-language capability or exact tool name. Supply query OR toolNames.' })),
  toolNames: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 5, uniqueItems: true })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: 'Maximum matches; defaults to 3 for search and 5 for listing. Not used with toolNames.' })),
}, { additionalProperties: false })

export type ToolSearchInput = Static<typeof toolSearchParameters>

export interface BuddyToolGroupSummary {
  namespace: string
  source: string
  description: string
  toolCount: number
  examples?: readonly string[]
}

export interface BuddyToolSearchCandidate {
  name: string
  description: string
  namespace?: string
  source?: string
}

export interface ToolSearchResult {
  version: 1
  tools: (BuddyToolSearchCandidate & { id?: string, title?: string, source: string, alreadyDisclosed: boolean, invocation?: 'codemode' })[]
  candidates: BuddyToolSearchCandidate[]
  groups?: BuddyToolGroupSummary[]
  nextOffset?: number
  notFound: string[]
}

export function isToolSearchResult(value: unknown): value is ToolSearchResult {
  if (!value || typeof value !== 'object')
    return false
  const result = value as Partial<ToolSearchResult>
  return result.version === 1 && Array.isArray(result.tools) && result.tools.length <= 5
    && result.tools.every(tool => tool && typeof tool.name === 'string' && typeof tool.description === 'string'
      && (tool.id === undefined || typeof tool.id === 'string') && (tool.title === undefined || typeof tool.title === 'string')
      && typeof tool.source === 'string' && typeof tool.alreadyDisclosed === 'boolean')
    && Array.isArray(result.candidates) && result.candidates.length <= 5
    && result.candidates.every(tool => tool && typeof tool.name === 'string' && typeof tool.description === 'string')
    && Array.isArray(result.notFound) && result.notFound.length <= 5
    && result.notFound.every(name => typeof name === 'string')
}
