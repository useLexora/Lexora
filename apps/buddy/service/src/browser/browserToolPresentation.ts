import type { BrowserAction } from '../../../shared/browser'
import type { BuddyToolPresentation } from '../../../shared/runs/runEventPresentation'
import type { CreateBuddyToolPresentationInput } from '../events/toolPresentationSupport'
import type { BrowserToolFailureCode, BrowserToolOperation } from './browserToolContract'
import {
  BROWSER_ACTION_KINDS,
  BROWSER_ERROR_CODES,
  BROWSER_MAX_OBSERVATION_ELEMENT_LIMIT,
} from '../../../shared/browser'
import {
  readBoolean,
  readOptionalString,
  readRecord,
  readToolDetails,
  readToolOutput,
} from '../events/toolPresentationSupport'
import {
  BROWSER_ACT_TOOL_NAME,
  BROWSER_OPEN_TOOL_NAME,
  BROWSER_READ_TOOL_NAME,
  BROWSER_SNAPSHOT_TOOL_NAME,
  isBrowserActToolInput,
} from './browserToolContract'

type BrowserToolPresentation = Extract<BuddyToolPresentation, { card: 'browser' }>
type BrowserPageStatus = BrowserToolPresentation['pageStatus']

const browserPageStatuses = new Set<BrowserPageStatus>([
  'error',
  'idle',
  'loading',
  'ready',
])

const browserToolFailureCodes = new Set<string>([
  ...BROWSER_ERROR_CODES,
  'BROWSER_CAPABILITY_FAILED',
  'INVALID_PATH',
  'PATH_NOT_FOUND',
  'PATH_OUTSIDE_GRANTED_DIRECTORY',
  'VALIDATION_FAILED',
] satisfies readonly BrowserToolFailureCode[])
const browserActionKinds = new Set<BrowserAction['kind']>(BROWSER_ACTION_KINDS)

export function createBrowserToolPresentation(
  input: CreateBuddyToolPresentationInput,
): BrowserToolPresentation | null {
  const operation = readOperation(input.toolName)
  if (!operation)
    return null

  const arguments_ = readRecord(input.arguments)
  const details = readToolDetails(input.result)
  const action = readAction(input.arguments, operation)
  const actionKind = action?.kind ?? readActionKind(details, operation)
  const inputSummary = readInputSummary(action)
  const errorCode = readErrorCode(details)
    ?? readExactErrorCode(input.result)
    ?? (input.isError ? 'BROWSER_CAPABILITY_FAILED' : null)
  const identity = readBrowserIdentity(details)
  const url = readBrowserEventUrl(
    readOptionalString(details, 'url') ?? readOpenUrl(arguments_, operation),
  )
  return {
    actionKind,
    card: 'browser',
    description: null,
    documentRevision: operation === 'snapshot'
      ? readNonNegativeInteger(details, 'documentRevision')
      : null,
    elementCount: operation === 'snapshot'
      ? readNonNegativeInteger(details, 'elementCount', BROWSER_MAX_OBSERVATION_ELEMENT_LIMIT)
      : null,
    errorCode,
    fieldType: inputSummary?.fieldType ?? null,
    inputLength: inputSummary?.inputLength ?? null,
    observationTruncated: operation === 'snapshot'
      ? readBoolean(details, 'truncated')
      : null,
    operation,
    origin: url?.origin ?? null,
    output: null,
    pageId: identity?.pageId ?? null,
    pageStatus: readPageStatus(details),
    pathname: url?.pathname ?? null,
    sessionId: identity?.sessionId ?? null,
    status: input.result === undefined
      ? 'running'
      : input.isError || errorCode
        ? 'failed'
        : 'completed',
    truncated: false,
  }
}

function readOperation(toolName: string): BrowserToolOperation | null {
  if (toolName === BROWSER_ACT_TOOL_NAME)
    return 'act'
  if (toolName === BROWSER_READ_TOOL_NAME)
    return 'read'
  if (toolName === BROWSER_OPEN_TOOL_NAME)
    return 'open'
  return toolName === BROWSER_SNAPSHOT_TOOL_NAME ? 'snapshot' : null
}

function readAction(
  arguments_: unknown,
  operation: BrowserToolOperation,
): BrowserAction | null {
  return operation === 'act' && isBrowserActToolInput(arguments_)
    ? arguments_.action
    : null
}

function readActionKind(
  details: Record<string, unknown> | null,
  operation: BrowserToolOperation,
): BrowserAction['kind'] | null {
  const kind = readOptionalString(details, 'actionKind') as BrowserAction['kind'] | null
  return operation === 'act' && kind && browserActionKinds.has(kind) ? kind : null
}

function readInputSummary(action: BrowserAction | null): {
  fieldType: 'selection' | 'text'
  inputLength: number
} | null {
  if (action?.kind === 'fill' || action?.kind === 'type') {
    return {
      fieldType: 'text',
      inputLength: action.text.length,
    }
  }
  if (action?.kind === 'select') {
    return {
      fieldType: 'selection',
      inputLength: action.values.reduce((length, value) => length + value.length, 0),
    }
  }
  return null
}

function readOpenUrl(
  arguments_: Record<string, unknown> | null,
  operation: BrowserToolOperation,
): string | null {
  if (operation === 'open' && arguments_?.kind === 'url')
    return readOptionalString(arguments_, 'url')
  const action = readAction(arguments_, operation)
  return action?.kind === 'navigate' ? action.url : null
}

function readBrowserIdentity(details: Record<string, unknown> | null): {
  pageId: string
  sessionId: string
} | null {
  const pageId = readOptionalString(details, 'pageId')
  const sessionId = readOptionalString(details, 'sessionId')
  return pageId && sessionId && isUuid(pageId) && isUuid(sessionId)
    ? { pageId, sessionId }
    : null
}

function readPageStatus(details: Record<string, unknown> | null): BrowserPageStatus {
  const status = readOptionalString(details, 'status') as BrowserPageStatus | null
  return status && browserPageStatuses.has(status) ? status : null
}

function readErrorCode(details: Record<string, unknown> | null): BrowserToolFailureCode | null {
  const code = readOptionalString(details, 'code')
  return code && browserToolFailureCodes.has(code)
    ? code as BrowserToolFailureCode
    : null
}

function readExactErrorCode(result: unknown): BrowserToolFailureCode | null {
  const code = readToolOutput(result)
  return code && browserToolFailureCodes.has(code)
    ? code as BrowserToolFailureCode
    : null
}

function readNonNegativeInteger(
  value: Record<string, unknown> | null,
  key: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  const candidate = value?.[key]
  return typeof candidate === 'number'
    && Number.isSafeInteger(candidate)
    && candidate >= 0
    && candidate <= maximum
    ? candidate
    : null
}

function readBrowserEventUrl(rawUrl: string | null): {
  origin: string
  pathname: '/' | '/[redacted]'
} | null {
  if (!rawUrl || rawUrl === 'about:blank')
    return null
  try {
    const url = new URL(rawUrl)
    if (url.protocol === 'file:') {
      return {
        origin: 'file://',
        pathname: '/[redacted]',
      }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return null
    return {
      origin: url.origin,
      pathname: url.pathname === '/'
        ? '/'
        : '/[redacted]',
    }
  }
  catch {
    return null
  }
}

function isUuid(value: string): boolean {
  return /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value)
}
