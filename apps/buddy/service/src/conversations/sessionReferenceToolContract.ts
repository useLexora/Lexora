import type { Static } from 'typebox'
import type { BuddyToolPresentation } from '../../../shared/runs/runEventPresentation'
import type { CreateBuddyToolPresentationInput } from '../events/toolPresentationSupport'
import { Type } from 'typebox'
import { redactSensitiveText } from '../../../shared/permissions/approvalReviewPayload'
import { toPiToolGroup } from '../agent/extensions/piToolGroup'
import { boundedToolPreview, readOptionalString, readRecord, readToolDetails, readToolOutput } from '../events/toolPresentationSupport'

export const SESSION_TOOLS = toPiToolGroup({ name: 'lexora_session', description: 'Search and read user-referenced task materials on the accepted conversation branch, including bounded reference chains.', tools: [{ name: 'search' }, { name: 'read' }] })

export const SESSION_SEARCH_TOOL = SESSION_TOOLS.search.name
export const SESSION_READ_TOOL = SESSION_TOOLS.read.name

const id = Type.String({ minLength: 1, maxLength: 128 })
export const sessionReferenceSourceSchema = Type.Union([
  Type.Object({ kind: Type.Literal('message'), messageId: id }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('resource'), messageId: id, resourceId: id }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('attachment'), messageId: id, attachmentId: id }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('artifact'), artifactId: id }, { additionalProperties: false }),
])
export type SessionReferenceSource = Static<typeof sessionReferenceSourceSchema>

export const sessionSearchParameters = Type.Object({
  sessionId: Type.String({ minLength: 1, maxLength: 128, description: 'ID of an available task in the current reference access catalogue.' }),
  branchId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: 'Branch ID returned by an earlier search. Supply it when continuing that search; a changed branch requires a new authorized search.' })),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: 'Keywords in messages or resource names and paths. Omit to browse recent messages and the resource catalogue. Does not search inside files.' })),
  kind: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('messages'), Type.Literal('resources')], { description: 'Defaults to all. Select a kind when continuing its results.' })),
  messageOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'How many of the newest messages earlier searches already covered. 0 (or omit) for a new search; nextMessageOffset from the previous message search to continue.' })),
  resourceOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'How many resources earlier searches already covered. 0 (or omit) for a new search; nextResourceOffset from the previous resource search to continue.' })),
}, { additionalProperties: false })

export const sessionReadParameters = Type.Object({
  sessionId: Type.String({ minLength: 1, maxLength: 128, description: 'ID of an available task in the current reference access catalogue.' }),
  branchId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: 'Branch ID returned by search. Supply it to prevent reading a source from another branch.' })),
  source: sessionReferenceSourceSchema,
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'Zero-based text offset. Use nextOffset to continue reading the same source.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000, description: 'Maximum text characters returned, default 12000.' })),
}, { additionalProperties: false })

export function createSessionReferenceToolPresentation(input: CreateBuddyToolPresentationInput): BuddyToolPresentation | null {
  if (input.toolName !== SESSION_SEARCH_TOOL && input.toolName !== SESSION_READ_TOOL)
    return null
  const args = readRecord(input.arguments)
  const details = readToolDetails(input.result)
  return {
    card: 'session',
    sessionId: readOptionalString(args, 'sessionId')?.slice(0, 128) ?? null,
    title: readOptionalString(details, 'title')?.slice(0, 200) ?? null,
    target: readOptionalString(details, 'target')?.slice(0, 4096) ?? readOptionalString(args, 'query')?.slice(0, 500) ?? null,
    description: null,
    ...boundedToolPreview(readOptionalString(details, 'preview')
      ? redactSensitiveText(readOptionalString(details, 'preview')!)
      : readToolOutput(input.result)),
  }
}
