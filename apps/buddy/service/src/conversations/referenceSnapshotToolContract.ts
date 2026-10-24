import type { BuddySettings } from '../../../shared/buddies/buddySettings'
import { Type } from 'typebox'
import { TEXT_MATERIAL_READ_DEFAULT_UNITS, TEXT_MATERIAL_READ_MAX_BYTES, TEXT_MATERIAL_READ_MAX_UNITS } from '../../../shared/conversation/textMaterialRead'
import { toolCatalogId } from '../agent/extensions/discovery/toolCatalog'
import { toPiToolGroup } from '../agent/extensions/piToolGroup'

export const REFERENCE_TOOLS = toPiToolGroup({ name: 'lexora_reference', description: 'Read immutable excerpts saved with accepted user messages on this task branch.', tools: [{ name: 'list' }, { name: 'read' }] })
export const REFERENCE_TOOL_SOURCE = { kind: 'builtin', id: 'reference_snapshot', title: 'Saved references' } as const

export function canReadReferenceSnapshots(selection: BuddySettings['tools']): boolean {
  return selection.mode === 'all' || (selection.mode === 'selected'
    && Object.values(REFERENCE_TOOLS).every(tool => selection.ids.includes(toolCatalogId(REFERENCE_TOOL_SOURCE, tool))))
}

const identity = Type.String({ minLength: 1, maxLength: 128 })
const offset = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
export const referenceListParameters = Type.Object({
  sourceMessageId: Type.Optional(identity),
  offset: Type.Optional(offset),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: 'Maximum references, default 20. Use nextOffset to continue.' })),
}, { additionalProperties: false })

export const referenceReadParameters = Type.Object({
  referenceId: identity,
  sourceMessageId: Type.String({ minLength: 1, maxLength: 128, description: 'User message that carries the saved reference, not the original quoted message.' }),
  kind: Type.Union([Type.Literal('message'), Type.Literal('resource'), Type.Literal('attachment')]),
  offset: Type.Optional(offset),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TEXT_MATERIAL_READ_MAX_UNITS, description: `Maximum UTF-16 text units, default ${TEXT_MATERIAL_READ_DEFAULT_UNITS}. Pages are also bounded to ${TEXT_MATERIAL_READ_MAX_BYTES} UTF-8 bytes including JSON string escaping and never split a surrogate pair. Use nextOffset to continue the same snapshot.` })),
}, { additionalProperties: false })
