import type {
  BrowserObservation,
  BrowserRecoveryAction,
  BrowserWaitSpec,
} from '../../../shared/browser'
import type {
  BrowserAdapterIssueLeaseParams,
  BrowserAdapterLease,
} from '../../../shared/browser/browserAdapterProtocol'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { BrowserHost } from './BrowserHost'
import {
  BROWSER_WAIT_DEFAULT_QUIET_MS,
  browserAcquireControlParamsSchema,
  browserAcquireControlResultSchema,
  browserActParamsSchema,
  browserActResultSchema,
  browserCloseResultSchema,
  browserErrorCodeSchema,
  browserFailureReasonSchema,
  browserObservationSchema,
  browserObserveParamsSchema,
  browserObserveResultSchema,
  browserOpenParamsSchema,
  browserOpenResultSchema,
  browserReleaseControlParamsSchema,
  browserReleaseControlResultSchema,
  browserSessionParamsSchema,
  browserStateResultSchema,
  browserValidateActionParamsSchema,
  browserValidateActionResultSchema,
} from '../../../shared/browser'
import {
  browserAdapterIssueLeaseParamsSchema,
  browserAdapterLeaseSchema,
} from '../../../shared/browser/browserAdapterProtocol'
import { redactBrowserRuntimeUrl } from './browserPrivacy'
import { browserRecovery, projectBrowserState } from './browserRuntimeProjection'

interface BrowserResultSchema {
  parse: (value: unknown) => unknown
}

const BROWSER_OPEN_DEFAULT_WAIT = {
  condition: 'dom-stable',
  quietMs: BROWSER_WAIT_DEFAULT_QUIET_MS,
  timeoutMs: 1_500,
} as const satisfies BrowserWaitSpec

export interface RegisterBrowserHostRpcOptions {
  createAdapterLease?: (input: BrowserAdapterIssueLeaseParams) => BrowserAdapterLease
  getHost: () => BrowserHost | null
}

export function registerBrowserHostRpc(
  peer: RuntimeRpcPeerContract,
  options: RegisterBrowserHostRpcOptions,
): () => void {
  const disposers = [
    peer.onRequest('host.browser.open', async (params) => {
      const input = browserOpenParamsSchema.parse(params)
      return runBrowserHostOperation(
        async () => {
          const host = requireBrowserHost(options.getHost())
          const session = host.ensureSession(input.conversationId)
          const state = await (input.target.kind === 'url'
            ? host.navigate(session.sessionId, input.target.url)
            : host.openLocalFile(session.sessionId, {
                entryPath: input.target.entryPath,
                rootPath: input.target.rootPath,
              }))
          const until = await host.waitFor(
            session.sessionId,
            input.until ?? BROWSER_OPEN_DEFAULT_WAIT,
          )
          return {
            state,
            ...(input.until ? { until } : {}),
          }
        },
        result => ({
          ok: true,
          state: projectBrowserState(result.state),
          ...(result.until ? { until: result.until } : {}),
        }),
        browserOpenResultSchema,
        'open_again',
      )
    }),
    peer.onRequest('host.browser.observe', async (params) => {
      const input = browserObserveParamsSchema.parse(params)
      return runBrowserHostOperation(
        () => requireBrowserHost(options.getHost()).observe(input),
        observation => ({
          observation: projectBrowserObservation(observation),
          ok: true,
        }),
        browserObserveResultSchema,
        'read_again',
      )
    }),
    peer.onRequest('host.browser.act', async (params) => {
      const input = browserActParamsSchema.parse(params)
      return runBrowserHostOperation(
        () => requireBrowserHost(options.getHost()).act(input),
        result => ({
          actionKind: result.actionKind,
          observation: projectBrowserObservation(result.observation),
          ok: true,
          state: projectBrowserState(result.state),
        }),
        browserActResultSchema,
        'read_again',
      )
    }),
    peer.onRequest('host.browser.validateAction', async (params) => {
      const input = browserValidateActionParamsSchema.parse(params)
      return runBrowserHostOperation(
        () => requireBrowserHost(options.getHost()).validateAction(input),
        () => ({ ok: true }),
        browserValidateActionResultSchema,
        'read_again',
      )
    }),
    peer.onRequest('host.browser.acquireControl', async (params) => {
      const input = browserAcquireControlParamsSchema.parse(params)
      return runBrowserHostOperation(
        () => requireBrowserHost(options.getHost()).acquireControl(input),
        lease => ({ lease, ok: true }),
        browserAcquireControlResultSchema,
        'request_human_control',
      )
    }),
    peer.onRequest('host.browser.releaseControl', async (params) => {
      const input = browserReleaseControlParamsSchema.parse(params)
      return runBrowserHostOperation(
        () => requireBrowserHost(options.getHost()).releaseControl(input),
        () => ({ ok: true }),
        browserReleaseControlResultSchema,
        'request_human_control',
      )
    }),
    peer.onRequest('host.browser.getState', async (params) => {
      const input = browserSessionParamsSchema.parse(params)
      return runBrowserHostOperation(
        () => requireBrowserHost(options.getHost()).getState(input.sessionId),
        state => ({ ok: true, state: projectBrowserState(state) }),
        browserStateResultSchema,
        'read_again',
      )
    }),
    peer.onRequest('host.browser.close', async (params) => {
      const input = browserSessionParamsSchema.parse(params)
      return runBrowserHostOperation(
        () => requireBrowserHost(options.getHost()).close(input.sessionId),
        () => ({ ok: true }),
        browserCloseResultSchema,
        null,
      )
    }),
    peer.onRequest('host.browser.createAdapterLease', (params) => {
      const input = browserAdapterIssueLeaseParamsSchema.parse(params)
      if (!options.createAdapterLease) {
        throw Object.assign(new Error('Browser adapter is unavailable'), {
          code: 'BROWSER_SESSION_NOT_FOUND',
        })
      }
      return browserAdapterLeaseSchema.parse(options.createAdapterLease(input))
    }),
  ]
  return () => {
    try {
      options.getHost()?.releaseRuntimeControl()
    }
    catch {}
    disposers.forEach(dispose => dispose())
  }
}

function projectBrowserObservation(
  observation: BrowserObservation,
) {
  return browserObservationSchema.parse({
    ...observation,
    url: redactBrowserRuntimeUrl(observation.url),
  })
}

async function runBrowserHostOperation<T>(
  operation: () => Promise<T> | T,
  success: (value: T) => unknown,
  schema: BrowserResultSchema,
  fallbackRecovery: BrowserRecoveryAction | null,
): Promise<unknown> {
  try {
    return schema.parse(success(await operation()))
  }
  catch (error) {
    return schema.parse(browserFailure(error, fallbackRecovery))
  }
}

function browserFailure(
  error: unknown,
  fallbackRecovery: BrowserRecoveryAction | null,
) {
  const parsedCode = browserErrorCodeSchema.safeParse(
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : null,
  )
  const code = parsedCode.success ? parsedCode.data : 'BROWSER_PAGE_FAILED'
  const parsedReason = browserFailureReasonSchema.safeParse(
    typeof error === 'object' && error !== null && 'reason' in error
      ? error.reason
      : null,
  )
  const reason = parsedReason.success ? parsedReason.data : null
  return {
    error: {
      code,
      reason,
      recovery: browserRecovery(code, fallbackRecovery),
    },
    ok: false,
  } as const
}

function requireBrowserHost(host: BrowserHost | null): BrowserHost {
  if (!host) {
    throw Object.assign(new Error('Browser host is unavailable'), {
      code: 'BROWSER_SESSION_NOT_FOUND',
    })
  }
  return host
}
