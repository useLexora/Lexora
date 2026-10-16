import type { ToolCallEvent } from '@earendil-works/pi-coding-agent'
import type { Static, TSchema } from 'typebox'
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
import type { BrowserCommitEffect } from '../approvals/browser/classifyBrowserAction'
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
  BROWSER_ACTION_TEXT_MAX_LENGTH,
  BROWSER_MAX_OBSERVATION_ELEMENT_LIMIT,
  BROWSER_MAX_WAIT_TIMEOUT_MS,
  BROWSER_PRESS_KEYS,
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

const browserElementRef = Type.String({ pattern: '^e[1-9]\\d*$' })
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

export const browserActToolParameters = Type.Union([
  targetlessBrowserAction({
    kind: Type.Literal('navigate'),
    url: browserUrl,
  }),
  ...(['back', 'forward', 'reload', 'stop'] as const).map(kind => (
    targetlessBrowserAction({ kind: Type.Literal(kind) })
  )),
  targetedBrowserAction({
    kind: Type.Literal('click'),
    ref: browserElementRef,
  }),
  ...(['fill', 'type'] as const).map(kind => targetedBrowserAction({
    kind: Type.Literal(kind),
    ref: browserElementRef,
    text: Type.String({
      maxLength: BROWSER_ACTION_TEXT_MAX_LENGTH,
      ...(kind === 'type' ? { minLength: 1 } : {}),
    }),
  })),
  targetlessBrowserAction({
    key: browserPressKey,
    kind: Type.Literal('press'),
  }),
  targetedBrowserAction({
    key: browserPressKey,
    kind: Type.Literal('press'),
    ref: browserElementRef,
  }),
  targetedBrowserAction({
    kind: Type.Literal('select'),
    ref: browserElementRef,
    values: Type.Array(Type.String({ maxLength: 4_096 }), {
      maxItems: 32,
      minItems: 1,
      uniqueItems: true,
    }),
  }),
  targetlessBrowserAction({
    amount: Type.Union([Type.Literal('page'), Type.Literal('half-page')]),
    direction: Type.Union([Type.Literal('up'), Type.Literal('down')]),
    kind: Type.Literal('scroll'),
  }),
  targetedBrowserAction({
    amount: Type.Union([Type.Literal('page'), Type.Literal('half-page')]),
    direction: Type.Union([Type.Literal('up'), Type.Literal('down')]),
    kind: Type.Literal('scroll'),
    ref: browserElementRef,
  }),
  ...(['page-ready', 'url-changed'] as const).map(condition => targetlessBrowserAction({
    condition: Type.Literal(condition),
    kind: Type.Literal('wait'),
    timeoutMs: browserWaitTimeoutMs,
  })),
  targetlessBrowserAction({
    condition: Type.Literal('url-matches'),
    kind: Type.Literal('wait'),
    pattern: browserWaitText,
    timeoutMs: browserWaitTimeoutMs,
  }),
  targetlessBrowserAction({
    condition: Type.Literal('text-visible'),
    kind: Type.Literal('wait'),
    text: browserWaitText,
    timeoutMs: browserWaitTimeoutMs,
  }),
  ...(['ref-visible', 'ref-hidden'] as const).map(condition => targetedBrowserAction({
    condition: Type.Literal(condition),
    kind: Type.Literal('wait'),
    ref: browserElementRef,
    timeoutMs: browserWaitTimeoutMs,
  })),
  targetlessBrowserAction({
    condition: Type.Literal('dom-stable'),
    kind: Type.Literal('wait'),
    quietMs: Type.Optional(Type.Integer({
      maximum: BROWSER_WAIT_MAX_QUIET_MS,
      minimum: 50,
    })),
    timeoutMs: browserWaitTimeoutMs,
  }),
], { type: 'object' })

function targetedBrowserAction(action: Record<string, TSchema>) {
  return Type.Object({
    action: Type.Object(action, { additionalProperties: false }),
    ...browserActionIdentity,
    frameId: browserFrameId,
  }, { additionalProperties: false })
}

function targetlessBrowserAction(action: Record<string, TSchema>) {
  return Type.Object({
    action: Type.Object(action, { additionalProperties: false }),
    ...browserActionIdentity,
  }, { additionalProperties: false })
}

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
    switch (classification.risk) {
      case 'sensitive-input':
        return createToolClassificationFailure('BROWSER_HUMAN_INPUT_REQUIRED')
      case 'commit-like':
        return browserApprovalClassification({
          actionClassifier,
          effect: classification.effect,
          input,
          review: classification.approvalReview,
          risk: classification.risk,
          summary: browserApprovalSummary(classification.effect),
        })
      case 'unknown-commit-like':
        return browserApprovalClassification({
          actionClassifier,
          effect: null,
          input,
          review: classification.approvalReview,
          risk: classification.risk,
          summary: 'Confirm an ambiguous browser action',
        })
      case 'read':
        return { access: 'read' }
      case 'navigation':
      case 'reversible-edit':
        return { access: 'interaction' }
    }
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
    ? { access: 'network' }
    : {
        access: 'render',
        paths: [{ mode: 'existing', path: event.input.entryPath }],
      }
}

function browserApprovalClassification(input: {
  actionClassifier: BrowserActionPolicyClassifier | undefined
  effect: BrowserCommitEffect | null
  input: BrowserCapabilityActParams
  review: BrowserApprovalReviewInput | undefined
  risk: 'commit-like' | 'unknown-commit-like'
  summary: string
}): BuddyToolClassificationResult {
  const actionClassifier = input.actionClassifier
  if (
    !input.review
    || input.review.risk !== input.risk
    || input.review.effect !== input.effect
    || !actionClassifier?.validateActionApproval
  ) {
    return createToolClassificationFailure('BROWSER_TARGET_STALE')
  }
  const review = input.review
  return {
    forceAsk: true,
    approval: {
      browser: review,
      kind: 'browser',
      summary: input.summary,
    },
    validateBeforeExecution: () => actionClassifier.validateActionApproval!(input.input, review),
  }
}

function browserApprovalSummary(effect: BrowserCommitEffect): string {
  switch (effect) {
    case 'account-change': return 'Change an account in the browser'
    case 'authorize': return 'Authorize access in the browser'
    case 'delete': return 'Delete content in the browser'
    case 'publish': return 'Publish content in the browser'
    case 'purchase': return 'Make a purchase or payment in the browser'
    case 'send': return 'Send content in the browser'
    case 'submit': return 'Submit content in the browser'
  }
}
