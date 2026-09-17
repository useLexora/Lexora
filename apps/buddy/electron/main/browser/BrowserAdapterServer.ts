import type { Server, Socket } from 'node:net'
import type { LocalEndpoint } from '../../../platform/ipc/localTransport'
import type {
  BrowserAcquireControlParams,
  BrowserAction,
  BrowserActParams,
  BrowserCapabilityActParams,
  BrowserControlLease,
  BrowserObservation,
  BrowserObserveParams,
  BrowserValidateActionParams,
} from '../../../shared/browser'
import type {
  BrowserAdapterFailureCode,
  BrowserAdapterIssueLeaseParams,
  BrowserAdapterLease,
  BrowserAdapterRequest,
  BrowserAdapterResponse,
  BrowserAdapterSuccessResult,
} from '../../../shared/browser/browserAdapterProtocol'
import type { DesktopBrowserState } from '../../../shared/browser/browserDesktopApi'
import type { BrowserHostActionResult } from './BrowserHost'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { browserObservationSchema } from '../../../shared/browser'
import {
  BROWSER_ADAPTER_DEFAULT_LEASE_TTL_MS,
  BROWSER_ADAPTER_MAX_REQUEST_BYTES,
  BROWSER_ADAPTER_PROTOCOL_VERSION,
  browserAdapterFailureCodeSchema,
  browserAdapterIssueLeaseParamsSchema,
  browserAdapterLeaseSchema,
  browserAdapterRequestSchema,
  browserAdapterResponseSchema,
} from '../../../shared/browser/browserAdapterProtocol'
import { redactBrowserRuntimeUrl } from './browserPrivacy'
import { projectBrowserState } from './browserRuntimeProjection'

interface BrowserAdapterHostPort {
  acquireControl: (input: BrowserAcquireControlParams) => BrowserControlLease
  act: (input: BrowserActParams) => Promise<BrowserHostActionResult>
  getState: (sessionId: string) => DesktopBrowserState
  getStateForConversation: (conversationId: string) => DesktopBrowserState
  observe: (input: BrowserObserveParams) => Promise<BrowserObservation>
  releaseControl: (input: BrowserControlLease) => DesktopBrowserState
  validateAction: (input: BrowserValidateActionParams) => void
}

interface BrowserAdapterServerOptions {
  createToken?: () => string
  getHost: () => BrowserAdapterHostPort | null
  now?: () => number
  endpoint: LocalEndpoint
}

interface AdapterLeaseRecord {
  activeConnection: AdapterConnection | null
  activeControl: BrowserControlLease | null
  busy: boolean
  conversationId: string
  expiresAt: number
  pageId: string
  sessionId: string
}

interface AdapterConnection {
  buffer: string
  closed: boolean
  record: AdapterLeaseRecord | null
  socket: Socket
  tail: Promise<void>
}

const requestIdPattern = /^[\w.-]{1,128}$/

export class BrowserAdapterServer {
  readonly #createToken: () => string
  readonly #getHost: () => BrowserAdapterHostPort | null
  readonly #leases = new Map<string, AdapterLeaseRecord>()
  readonly #now: () => number
  readonly #endpoint: LocalEndpoint
  readonly #socketPath: string
  readonly #sockets = new Set<Socket>()
  #server: Server | null = null

  constructor(options: BrowserAdapterServerOptions) {
    this.#createToken = options.createToken ?? (() => randomBytes(32).toString('hex'))
    this.#getHost = options.getHost
    this.#now = options.now ?? Date.now
    this.#endpoint = options.endpoint
    this.#socketPath = options.endpoint.address
  }

  async start(): Promise<void> {
    if (this.#server)
      return
    await this.#endpoint.prepare()
    const server = createServer(socket => this.#accept(socket))
    try {
      await new Promise<void>((resolve, reject) => {
        function onError(error: Error) {
          server.off('listening', onListening)
          reject(error)
        }
        function onListening() {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.#socketPath)
      })
      await this.#endpoint.secure()
      this.#server = server
    }
    catch (error) {
      server.close()
      await this.#endpoint.dispose()
      throw error
    }
  }

  issueLease(rawInput: BrowserAdapterIssueLeaseParams): BrowserAdapterLease {
    if (!this.#server)
      throw new BrowserAdapterServerError('BROWSER_ADAPTER_REQUEST_INVALID')
    const input = browserAdapterIssueLeaseParamsSchema.parse(rawInput)
    const state = requireHost(this.#getHost()).getStateForConversation(input.conversationId)
    if (state.conversationId !== input.conversationId)
      throw new BrowserAdapterServerError('BROWSER_SESSION_NOT_FOUND')
    const token = this.#issueToken()
    const expiresAt = this.#now()
      + (input.ttlMs ?? BROWSER_ADAPTER_DEFAULT_LEASE_TTL_MS)
    this.#leases.set(hashToken(token), {
      activeConnection: null,
      activeControl: null,
      busy: false,
      conversationId: state.conversationId,
      expiresAt,
      pageId: state.pageId,
      sessionId: state.sessionId,
    })
    return browserAdapterLeaseSchema.parse({
      conversationId: state.conversationId,
      expiresAt: new Date(expiresAt).toISOString(),
      pageId: state.pageId,
      protocolVersion: BROWSER_ADAPTER_PROTOCOL_VERSION,
      sessionId: state.sessionId,
      socketPath: this.#socketPath,
      token,
    })
  }

  revokeSession(sessionId: string): void {
    for (const [digest, record] of this.#leases) {
      if (record.sessionId !== sessionId)
        continue
      this.#leases.delete(digest)
      void this.#releaseControl(record)
    }
  }

  async dispose(): Promise<void> {
    const server = this.#server
    this.#server = null
    const records = [...this.#leases.values()]
    this.#leases.clear()
    await Promise.all(records.map(record => this.#releaseControl(record)))
    for (const socket of this.#sockets)
      socket.destroy()
    this.#sockets.clear()
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
    await this.#endpoint.dispose()
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket)
    socket.setEncoding('utf8')
    const connection: AdapterConnection = {
      buffer: '',
      closed: false,
      record: null,
      socket,
      tail: Promise.resolve(),
    }
    socket.on('data', (chunk: string) => this.#read(connection, chunk))
    socket.once('close', () => {
      connection.closed = true
      this.#sockets.delete(socket)
      void this.#releaseConnectionControl(connection)
    })
    socket.once('error', () => {})
  }

  #read(connection: AdapterConnection, chunk: string): void {
    connection.buffer += chunk
    if (Buffer.byteLength(connection.buffer, 'utf8') > BROWSER_ADAPTER_MAX_REQUEST_BYTES) {
      connection.buffer = ''
      this.#write(connection, failure('invalid-request', 'BROWSER_ADAPTER_REQUEST_INVALID'))
      connection.socket.end()
      return
    }

    let newline = connection.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = connection.buffer.slice(0, newline)
      connection.buffer = connection.buffer.slice(newline + 1)
      connection.tail = connection.tail
        .then(() => this.#handleLine(connection, line))
        .catch(() => {})
      newline = connection.buffer.indexOf('\n')
    }
  }

  async #handleLine(connection: AdapterConnection, line: string): Promise<void> {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    }
    catch {
      this.#write(connection, failure('invalid-request', 'BROWSER_ADAPTER_REQUEST_INVALID'))
      return
    }
    const parsed = browserAdapterRequestSchema.safeParse(raw)
    if (!parsed.success) {
      this.#write(
        connection,
        failure(readRequestId(raw), 'BROWSER_ADAPTER_REQUEST_INVALID'),
      )
      return
    }

    const request = parsed.data
    const authentication = this.#authenticate(request)
    if ('response' in authentication) {
      this.#write(connection, authentication.response)
      return
    }
    connection.record = authentication.record

    try {
      const result = await this.#dispatch(connection, request, authentication.record)
      this.#write(connection, success(request.id, result))
      if (request.method === 'close')
        connection.socket.end()
    }
    catch (error) {
      const code = readFailureCode(error)
      if (code === 'BROWSER_SESSION_EVICTED' || code === 'BROWSER_SESSION_NOT_FOUND')
        this.#revoke(request.token, authentication.record)
      this.#write(connection, failure(request.id, code))
    }
  }

  #authenticate(request: BrowserAdapterRequest): {
    record: AdapterLeaseRecord
  } | {
    response: BrowserAdapterResponse
  } {
    const digest = hashToken(request.token)
    const record = this.#leases.get(digest)
    if (!record) {
      return {
        response: failure(request.id, 'BROWSER_ADAPTER_AUTH_FAILED'),
      }
    }
    if (record.expiresAt <= this.#now()) {
      this.#leases.delete(digest)
      void this.#releaseControl(record)
      return {
        response: failure(request.id, 'BROWSER_ADAPTER_LEASE_EXPIRED'),
      }
    }
    return { record }
  }

  async #dispatch(
    connection: AdapterConnection,
    request: BrowserAdapterRequest,
    record: AdapterLeaseRecord,
  ): Promise<BrowserAdapterSuccessResult> {
    const host = requireHost(this.#getHost())
    const state = requireBoundState(host, record)
    switch (request.method) {
      case 'state':
        return { kind: 'state', state: projectBrowserState(state) }
      case 'snapshot': {
        const rawObservation = await host.observe({
          ...request.params,
          pageId: state.pageId,
          sessionId: state.sessionId,
        })
        const observation = projectBrowserObservation(rawObservation)
        if (
          observation.pageId !== state.pageId
          || observation.sessionId !== state.sessionId
        ) {
          throw new BrowserAdapterServerError('BROWSER_TARGET_STALE')
        }
        return { kind: 'snapshot', observation }
      }
      case 'action':
        return this.#act(connection, host, record, request.params)
      case 'close':
        this.#revoke(request.token, record)
        return { kind: 'close', revoked: true }
    }
  }

  async #act(
    connection: AdapterConnection,
    host: BrowserAdapterHostPort,
    record: AdapterLeaseRecord,
    input: BrowserCapabilityActParams,
  ): Promise<BrowserAdapterSuccessResult> {
    if (record.busy)
      throw new BrowserAdapterServerError('BROWSER_CONTROL_REQUIRED')
    host.validateAction({ ...input, sessionId: record.sessionId })
    if (requiresBuddyApproval(input.action)) {
      throw new BrowserAdapterServerError('BROWSER_ADAPTER_APPROVAL_REQUIRED')
    }

    record.busy = true
    try {
      const lease = host.acquireControl({
        pageId: input.pageId,
        sessionId: record.sessionId,
      })
      if (lease.pageId !== input.pageId || lease.sessionId !== record.sessionId) {
        await safelyRelease(host, lease)
        throw new BrowserAdapterServerError('BROWSER_TARGET_STALE')
      }
      record.activeControl = lease
      record.activeConnection = connection
      connection.record = record
      const result = await host.act({
        ...input,
        controlEpoch: lease.controlEpoch,
        sessionId: lease.sessionId,
      })
      await this.#releaseControl(record)
      const state = requireBoundState(host, record)
      const observation = projectBrowserObservation(result.observation)
      if (
        observation.pageId !== state.pageId
        || observation.sessionId !== state.sessionId
      ) {
        throw new BrowserAdapterServerError('BROWSER_TARGET_STALE')
      }
      return {
        actionKind: result.actionKind,
        kind: 'action',
        observation,
        state: projectBrowserState(state),
      }
    }
    finally {
      await this.#releaseControl(record)
      record.busy = false
    }
  }

  #revoke(token: string, record: AdapterLeaseRecord): void {
    this.#leases.delete(hashToken(token))
    void this.#releaseControl(record)
  }

  async #releaseConnectionControl(connection: AdapterConnection): Promise<void> {
    if (connection.record)
      await this.#releaseControl(connection.record, connection)
  }

  async #releaseControl(
    record: AdapterLeaseRecord,
    connection?: AdapterConnection,
  ): Promise<void> {
    if (connection && record.activeConnection !== connection)
      return
    const lease = record.activeControl
    if (!lease)
      return
    record.activeConnection = null
    record.activeControl = null
    await safelyRelease(this.#getHost(), lease)
  }

  #write(connection: AdapterConnection, response: BrowserAdapterResponse): void {
    if (!connection.closed && !connection.socket.destroyed)
      connection.socket.write(`${JSON.stringify(browserAdapterResponseSchema.parse(response))}\n`)
  }

  #issueToken(): string {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = this.#createToken()
      if (/^[\da-f]{64}$/.test(token) && !this.#leases.has(hashToken(token)))
        return token
    }
    throw new BrowserAdapterServerError('BROWSER_ADAPTER_REQUEST_INVALID')
  }
}

function projectBrowserObservation(observation: BrowserObservation) {
  return browserObservationSchema.parse({
    ...observation,
    url: redactBrowserRuntimeUrl(observation.url),
  })
}

class BrowserAdapterServerError extends Error {
  readonly code: BrowserAdapterFailureCode

  constructor(code: BrowserAdapterFailureCode) {
    super(code)
    this.code = code
    this.name = 'BrowserAdapterServerError'
  }
}

function requireHost(host: BrowserAdapterHostPort | null): BrowserAdapterHostPort {
  if (!host)
    throw new BrowserAdapterServerError('BROWSER_SESSION_NOT_FOUND')
  return host
}

function requireBoundState(
  host: BrowserAdapterHostPort,
  record: AdapterLeaseRecord,
): DesktopBrowserState {
  const state = host.getState(record.sessionId)
  if (
    state.conversationId !== record.conversationId
    || state.pageId !== record.pageId
    || state.sessionId !== record.sessionId
  ) {
    throw new BrowserAdapterServerError('BROWSER_SESSION_NOT_FOUND')
  }
  return state
}

function requiresBuddyApproval(action: BrowserAction): boolean {
  return action.kind === 'click'
    || (action.kind === 'press' && (action.key === 'Enter' || action.key === 'Space'))
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function success(id: string, result: BrowserAdapterSuccessResult): BrowserAdapterResponse {
  return browserAdapterResponseSchema.parse({
    id,
    ok: true,
    protocolVersion: BROWSER_ADAPTER_PROTOCOL_VERSION,
    result,
  })
}

function failure(id: string, code: BrowserAdapterFailureCode): BrowserAdapterResponse {
  return browserAdapterResponseSchema.parse({
    error: {
      code,
      recovery: recoveryFor(code),
    },
    id,
    ok: false,
    protocolVersion: BROWSER_ADAPTER_PROTOCOL_VERSION,
  })
}

function recoveryFor(code: BrowserAdapterFailureCode) {
  switch (code) {
    case 'BROWSER_ADAPTER_APPROVAL_REQUIRED': return 'request_buddy_approval' as const
    case 'BROWSER_ADAPTER_AUTH_FAILED':
    case 'BROWSER_ADAPTER_LEASE_EXPIRED': return 'request_new_adapter_lease' as const
    case 'BROWSER_CONTROL_REQUIRED':
    case 'BROWSER_DIALOG_PENDING':
    case 'BROWSER_HUMAN_INPUT_REQUIRED': return 'request_human_control' as const
    case 'BROWSER_PAGE_CRASHED':
    case 'BROWSER_SESSION_EVICTED':
    case 'BROWSER_SESSION_NOT_FOUND': return 'open_again' as const
    case 'BROWSER_PAGE_UNRESPONSIVE':
    case 'BROWSER_TARGET_STALE': return 'read_again' as const
    default: return null
  }
}

function readFailureCode(error: unknown): BrowserAdapterFailureCode {
  const parsed = browserAdapterFailureCodeSchema.safeParse(
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : null,
  )
  return parsed.success ? parsed.data : 'BROWSER_PAGE_FAILED'
}

function readRequestId(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || !('id' in raw))
    return 'invalid-request'
  const id = (raw as { id?: unknown }).id
  return typeof id === 'string' && requestIdPattern.test(id)
    ? id
    : 'invalid-request'
}

async function safelyRelease(
  host: BrowserAdapterHostPort | null,
  lease: BrowserControlLease,
): Promise<void> {
  try {
    host?.releaseControl(lease)
  }
  catch {}
}
