import type { Api, Model } from '@earendil-works/pi-ai'
import type { Static } from 'typebox'
import { Type } from 'typebox'

export const TOOL_SEARCH_NAME = 'lexora_tool_search'

export interface BuddyToolDisclosurePolicy {
  group: 'browser' | 'automation' | 'system' | 'image_generation' | 'image_transform' | 'mcp' | 'plugins'
  keywords: string
  toolNames: readonly string[]
  available?: (model: Model<Api> | undefined, toolName: string) => boolean
}

export const toolSearchParameters = Type.Object({
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: 'Natural-language capability or exact tool name. Supply query OR toolNames.' })),
  toolNames: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 5, uniqueItems: true })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: 'Maximum query matches; default 3. Not used with toolNames.' })),
}, { additionalProperties: false })

export type ToolSearchInput = Static<typeof toolSearchParameters>

export interface ToolSearchResult {
  version: 1
  tools: { name: string, description: string, source: string, alreadyDisclosed: boolean }[]
  candidates: { name: string, description: string }[]
  notFound: string[]
}

export function isToolSearchResult(value: unknown): value is ToolSearchResult {
  if (!value || typeof value !== 'object')
    return false
  const result = value as Partial<ToolSearchResult>
  return result.version === 1 && Array.isArray(result.tools) && result.tools.length <= 5
    && result.tools.every(tool => tool && typeof tool.name === 'string' && typeof tool.description === 'string'
      && typeof tool.source === 'string' && typeof tool.alreadyDisclosed === 'boolean')
    && Array.isArray(result.candidates) && result.candidates.length <= 5
    && result.candidates.every(tool => tool && typeof tool.name === 'string' && typeof tool.description === 'string')
    && Array.isArray(result.notFound) && result.notFound.length <= 5
    && result.notFound.every(name => typeof name === 'string')
}
