import type { ToolCallEvent } from '@earendil-works/pi-coding-agent'
import type { Static } from 'typebox'
import type {
  BrowserAction,
  BrowserCapabilityActParams,
  BrowserErrorCode,
  BrowserFailureReason,
  BrowserObservation,
  BrowserReadOptions,
  BrowserRecoveryAction,
  BrowserStateSnapshot,
} from '../../../shared/browser'
import type { BrowserApprovalReviewInput } from '../../../shared/permissions/approvalReviewPayload'
import type { BuddyToolClassificationResult } from '../approvals/toolClassification'
import type { GrantedPathError } from '../directories/resolveGrantedPath'
import type {
  BrowserActionApprovalValidationResult,
  BrowserCapabilityActionClassificationResult,
} from './BrowserCapabilityService'
import { isAbsolute } from 'node:path'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import {
  BROWSER_ACTION_KINDS,
  BROWSER_ACTION_TEXT_MAX_LENGTH,
  BROWSER_MAX_OBSERVATION_ELEMENT_LIMIT,
  BROWSER_MAX_WAIT_TIMEOUT_MS,
  BROWSER_PRESS_KEYS,
  BROWSER_WAIT_CONDITIONS,
  BROWSER_WAIT_MAX_QUIET_MS,
  BROWSER_WAIT_TEXT_MAX_LENGTH,
  browserCapabilityActParamsSchema,
  browserReadOptionsSchema,
} from '../../../shared/browser'
import { toPiToolGroup } from '../agent/extensions/piToolGroup'
import { createToolClassificationFailure } from '../approvals/toolClassification'

export const BROWSER_TOOLS = toPiToolGroup({ name: 'lexora_browser', description: 'Open browser pages, read their content, inspect their state, and interact with page elements.', tools: [{ name: 'open' }, { name: 'snapshot' }, { name: 'read' }, { name: 'act' }] })

export const BROWSER_ACT_TOOL_NAME = BROWSER_TOOLS.act.name
export const BROWSER_OPEN_TOOL_NAME = BROWSER_TOOLS.open.name
export const BROWSER_READ_TOOL_NAME = BROWSER_TOOLS.read.name
export const BROWSER_SNAPSHOT_TOOL_NAME = BROWSER_TOOLS.snapshot.name

const browserUrl = Type.String({
  maxLength: 4_096,
  minLength: 1,
  pattern: '^[Hh][Tt][Tt][Pp][Ss]?://',
})

const browserEntryPath = Type.String({
  maxLength: 32_768,
  minLength: 1,
  pattern: '\\S',
})

const browserWaitTimeoutMs = Type.Integer({
  maximum: BROWSER_MAX_WAIT_TIMEOUT_MS,
  minimum: 1,
})
const browserWaitText = Type.String({
  maxLength: BROWSER_WAIT_TEXT_MAX_LENGTH,
  minLength: 1,
  pattern: '\\S',
})
const browserOpenWaitSpec = Type.Union([
  ...(['page-ready', 'url-changed'] as const).map(condition => Type.Object({
    condition: Type.Literal(condition),
    timeoutMs: browserWaitTimeoutMs,
  }, { additionalProperties: false })),
  Type.Object({
    condition: Type.Literal('url-matches'),
    pattern: browserWaitText,
    timeoutMs: browserWaitTimeoutMs,
  }, { additionalProperties: false }),
  Type.Object({
    condition: Type.Literal('text-visible'),
    text: browserWaitText,
    timeoutMs: browserWaitTimeoutMs,
  }, { additionalProperties: false }),
  Type.Object({
    condition: Type.Literal('dom-stable'),
    quietMs: Type.Optional(Type.Integer({
      maximum: BROWSER_WAIT_MAX_QUIET_MS,
      minimum: 50,
    })),
    timeoutMs: browserWaitTimeoutMs,
  }, { additionalProperties: false }),
])

export const browserOpenToolParameters = Type.Union([
  Type.Object({
    kind: Type.Literal('url'),
    until: Type.Optional(browserOpenWaitSpec),
    url: browserUrl,
  }, { additionalProperties: false }),
  Type.Object({
    entryPath: browserEntryPath,
    kind: Type.Literal('local-file'),
    until: Type.Optional(browserOpenWaitSpec),
  }, { additionalProperties: false }),
], { type: 'object' })

export const browserSnapshotToolParameters = Type.Object({
  mode: Type.Optional(Type.Union(['semantic', 'screenshot'].map(mode => Type.Literal(mode)), { description: 'Defaults to semantic for DOM/accessibility inspection. Choose screenshot for visual reasoning or unavailable semantics; returns the current viewport image, not an entire PDF or original image. Sensitive-input protection applies. Filters apply only to semantic mode.' })),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 256, pattern: '\\S', description: 'Match all whitespace-separated tokens in element names, descriptions, roles or safe values.' })),
  selector: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: '\\S', description: 'Limit interactive elements to the first matching CSS region in the main document.' })),
  maxElements: Type.Optional(Type.Integer({
    maximum: BROWSER_MAX_OBSERVATION_ELEMENT_LIMIT,
    minimum: 1,
  })),
}, { additionalProperties: false })

const browserElementRef = Type.String({ pattern: '^e[1-9]\\d*$', description: 'Element ref from the latest observation; place it inside action.' })
const browserFrameId = Type.String({ maxLength: 256, minLength: 1, pattern: '\\S' })
const browserId = Type.String({
  pattern: '^[\\da-fA-F]{8}-[\\da-fA-F]{4}-[1-8][\\da-fA-F]{3}-[89abAB][\\da-fA-F]{3}-[\\da-fA-F]{12}$',
})
const browserRevision = Type.Integer({
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: 0,
})
export const browserReadToolParameters = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 128, pattern: '^[\\da-fA-F-]{36}:\\d{1,6}$', description: 'Continue the captured read using the returned cursor; omit mode, selector and target.' })),
  maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  mode: Type.Optional(Type.Union(['text', 'links', 'tables'].map(mode => Type.Literal(mode)), { description: 'Content to extract; defaults to text. Tables return caption and indexed rows.' })),
  selector: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: '\\S', description: 'CSS region in the main document; text defaults to article, main or body.' })),
  target: Type.Optional(Type.Object({
    documentRevision: browserRevision,
    frameId: browserFrameId,
    observationId: browserId,
    ref: browserElementRef,
  }, { additionalProperties: false, description: 'Read an element from the latest snapshot, including elements in frames. Use target or selector.' })),
}, { additionalProperties: false })

const browserPressKey = Type.Union(BROWSER_PRESS_KEYS.map(key => Type.Literal(key)))
const browserActionIdentity = {
  documentRevision: browserRevision,
  observationId: browserId,
  pageId: browserId,
} as const

export const browserActToolParameters = Type.Object({
  ...browserActionIdentity,
  frameId: Type.Optional(Type.String({ ...browserFrameId, description: 'Required when action.ref is present: copy that element\'s frameId to this top-level field. Omit for actions without a ref.' })),
  action: Type.Object({
    kind: Type.Union(BROWSER_ACTION_KINDS.map(kind => Type.Literal(kind))),
    ref: Type.Optional(browserElementRef),
    text: Type.Optional(Type.String({ maxLength: BROWSER_ACTION_TEXT_MAX_LENGTH, description: 'Required for fill and type; fill replaces the field contents, including clearing with an empty string. Also required for wait with text-visible.' })),
    url: Type.Optional(Type.String({ ...browserUrl, description: 'Required only for navigate.' })),
    key: Type.Optional(browserPressKey),
    values: Type.Optional(Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: 32, minItems: 1, uniqueItems: true, description: 'Required only for select: option values.' })),
    direction: Type.Optional(Type.Union([Type.Literal('up'), Type.Literal('down')], { description: 'Required only for scroll.' })),
    amount: Type.Optional(Type.Union([Type.Literal('page'), Type.Literal('half-page')], { description: 'Required only for scroll.' })),
    condition: Type.Optional(Type.Union(BROWSER_WAIT_CONDITIONS.map(condition => Type.Literal(condition)), { description: 'Required only for wait, together with timeoutMs. ref-visible and ref-hidden also require ref and top-level frameId.' })),
    timeoutMs: Type.Optional(browserWaitTimeoutMs),
    pattern: Type.Optional(Type.String({ ...browserWaitText, description: 'Required only for wait with url-matches.' })),
    quietMs: Type.Optional(Type.Integer({ maximum: BROWSER_WAIT_MAX_QUIET_MS, minimum: 50, description: 'Optional only for wait with dom-stable.' })),
  }, { additionalProperties: false, description: 'One action; include only fields for that kind. click/fill/type/select require ref. press requires key and optionally ref. scroll optionally takes ref. Example: {"kind":"fill","ref":"e1","text":"search terms"}.' }),
}, { additionalProperties: false })

export type BrowserOpenToolInput = Static<typeof browserOpenToolParameters>
export type BrowserSnapshotToolInput = Static<typeof browserSnapshotToolParameters>
export type BrowserToolOperation = 'act' | 'open' | 'read' | 'snapshot'
export type BrowserToolFailureCode
  = BrowserErrorCode
    | GrantedPathError['code']
    | 'BROWSER_CAPABILITY_FAILED'
    | 'VALIDATION_FAILED'

export interface BrowserToolDetails {
  actionKind?: BrowserAction['kind']
  code?: BrowserToolFailureCode
  documentRevision?: number
  elementCount?: number
  observationId?: string
  observationStatus?: 'ready' | 'unavailable'
  operation: BrowserToolOperation
  pageId?: string
  recovery?: BrowserRecoveryAction | null
  reason?: BrowserFailureReason | null
  sessionId?: string
  status?: BrowserObservation['status'] | BrowserStateSnapshot['status']
  truncated?: boolean
  url?: string
  warningCode?: BrowserToolFailureCode
}

export function isBrowserOpenToolInput(input: unknown): input is BrowserOpenToolInput {
  if (!Check(browserOpenToolParameters, input))
    return false
  if (input.kind === 'local-file')
    return isAbsolute(input.entryPath)
  try {
    const url = new URL(input.url)
    return url.protocol === 'http:' || url.protocol === 'https:'
  }
  catch {
    return false
  }
}

export function isBrowserSnapshotToolInput(input: unknown): input is BrowserSnapshotToolInput {
  return Check(browserSnapshotToolParameters, input)
}

export function isBrowserReadToolInput(input: unknown): input is BrowserReadOptions {
  return browserReadOptionsSchema.safeParse(input).success
}

export function isBrowserActToolInput(input: unknown): input is BrowserCapabilityActParams {
  return browserCapabilityActParamsSchema.safeParse(input).success
}

export interface BrowserActionPolicyClassifier {
  classifyAction: (
    input: BrowserCapabilityActParams,
  ) => BrowserCapabilityActionClassificationResult
  validateActionApproval?: (
    input: BrowserCapabilityActParams,
    review: BrowserApprovalReviewInput,
  ) => Promise<BrowserActionApprovalValidationResult>
}

export function classifyBrowserTool(
  event: Pick<ToolCallEvent, 'input' | 'toolName'>,
  actionClassifier?: BrowserActionPolicyClassifier,
): BuddyToolClassificationResult | null {
  if (event.toolName === BROWSER_ACT_TOOL_NAME) {
    if (!isBrowserActToolInput(event.input))
      return createToolClassificationFailure('VALIDATION_FAILED')
    const input = event.input
    const classification = actionClassifier?.classifyAction(input)
    if (!classification)
      return createToolClassificationFailure('BROWSER_TARGET_STALE')
    if ('blocked' in classification)
      return createToolClassificationFailure(classification.reason)
    if (classification.access === 'read')
      return { access: 'read' }
    return browserInteractionClassification(actionClassifier, input, classification.approvalReview)
  }

  if (event.toolName === BROWSER_READ_TOOL_NAME) {
    return isBrowserReadToolInput(event.input)
      ? { access: 'read' }
      : createToolClassificationFailure('VALIDATION_FAILED')
  }
  if (event.toolName === BROWSER_SNAPSHOT_TOOL_NAME) {
    return isBrowserSnapshotToolInput(event.input)
      ? { access: 'read' }
      : createToolClassificationFailure('VALIDATION_FAILED')
  }
  if (event.toolName !== BROWSER_OPEN_TOOL_NAME)
    return null
  if (!isBrowserOpenToolInput(event.input))
    return createToolClassificationFailure('VALIDATION_FAILED')
  return event.input.kind === 'url'
    ? { access: 'network', networkManaged: true }
    : {
        access: 'render',
        paths: [{ mode: 'existing', path: event.input.entryPath }],
      }
}

function browserInteractionClassification(
  actionClassifier: BrowserActionPolicyClassifier | undefined,
  input: BrowserCapabilityActParams,
  review: BrowserApprovalReviewInput | undefined,
): BuddyToolClassificationResult {
  if (
    !review
    || review.risk !== 'interaction'
    || review.effect !== null
    || !actionClassifier?.validateActionApproval
  ) {
    return createToolClassificationFailure('BROWSER_TARGET_STALE')
  }
  return {
    access: 'interaction',
    approval: {
      browser: review,
      kind: 'browser',
      summary: 'Interact with a browser page',
    },
    validateBeforeExecution: () => actionClassifier.validateActionApproval!(input, review),
  }
}
