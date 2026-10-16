import type {
  BrowserAcquireControlParams,
  BrowserAcquireControlResult,
  BrowserActParams,
  BrowserActResult,
  BrowserCloseResult,
  BrowserObserveParams,
  BrowserObserveResult,
  BrowserOpenResult,
  BrowserReadParams,
  BrowserReadResult,
  BrowserReleaseControlParams,
  BrowserReleaseControlResult,
  BrowserScreenshotReadParams,
  BrowserScreenshotReadResult,
  BrowserStateResult,
  BrowserValidateActionParams,
  BrowserValidateActionResult,
  BrowserWaitSpec,
} from '../../../shared/browser'
import type {
  BrowserAdapterIssueLeaseParams,
  BrowserAdapterLease,
} from '../../../shared/browser/browserAdapterProtocol'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import {
  browserAcquireControlParamsSchema,
  browserAcquireControlResultSchema,
  browserActParamsSchema,
  browserActResultSchema,
  browserCloseResultSchema,
  browserObserveParamsSchema,
  browserObserveResultSchema,
  browserOpenParamsSchema,
  browserOpenResultSchema,
  browserReadParamsSchema,
  browserReadResultSchema,
  browserReleaseControlParamsSchema,
  browserReleaseControlResultSchema,
  browserScreenshotReadParamsSchema,
  browserScreenshotReadResultSchema,
  browserSessionParamsSchema,
  browserStateResultSchema,
  browserValidateActionParamsSchema,
  browserValidateActionResultSchema,
} from '../../../shared/browser'
import {
  browserAdapterIssueLeaseParamsSchema,
  browserAdapterLeaseSchema,
} from '../../../shared/browser/browserAdapterProtocol'
import { GrantedPathError, resolveGrantedPath } from '../directories/resolveGrantedPath'

export interface OpenBrowserUrlInput {
  conversationId: string
  until?: BrowserWaitSpec
  url: string
}

export interface OpenBrowserLocalInput {
  conversationId: string
  entryPath: string
  grants: readonly DirectoryGrant[]
  until?: BrowserWaitSpec
}

export class BrowserHostClient {
  readonly #peer: Pick<RuntimeRpcPeerContract, 'request'>

  constructor(peer: Pick<RuntimeRpcPeerContract, 'request'>) {
    this.#peer = peer
  }

  async createAdapterLease(
    input: BrowserAdapterIssueLeaseParams,
  ): Promise<BrowserAdapterLease> {
    const request = browserAdapterIssueLeaseParamsSchema.parse(input)
    return browserAdapterLeaseSchema.parse(await this.#peer.request(
      'host.browser.createAdapterLease',
      request,
    ))
  }

  async openUrl(input: OpenBrowserUrlInput): Promise<BrowserOpenResult> {
    const request = browserOpenParamsSchema.parse({
      conversationId: input.conversationId,
      target: { kind: 'url', url: input.url },
      ...(input.until ? { until: input.until } : {}),
    })
    return browserOpenResultSchema.parse(await this.#peer.request(
      'host.browser.open',
      request,
    ))
  }

  async openLocal(input: OpenBrowserLocalInput): Promise<BrowserOpenResult> {
    const grants = [...input.grants]
    const resolution = await resolveGrantedPath(grants, input.entryPath, 'existing')
    const grant = grants.find(candidate => (
      candidate.grantId === resolution.grantId
      && candidate.root === resolution.root
    ))
    if (!grant)
      throw new GrantedPathError('PATH_OUTSIDE_GRANTED_DIRECTORY')
    const request = browserOpenParamsSchema.parse({
      conversationId: input.conversationId,
      target: {
        entryPath: resolution.canonicalPath,
        kind: 'local-file',
        rootPath: grant.canonicalRoot,
      },
      ...(input.until ? { until: input.until } : {}),
    })
    return browserOpenResultSchema.parse(await this.#peer.request(
      'host.browser.open',
      request,
    ))
  }

  async observe(input: BrowserObserveParams): Promise<BrowserObserveResult> {
    const request = browserObserveParamsSchema.parse(input)
    return browserObserveResultSchema.parse(await this.#peer.request(
      'host.browser.observe',
      request,
    ))
  }

  async read(input: BrowserReadParams): Promise<BrowserReadResult> {
    const request = browserReadParamsSchema.parse(input)
    return browserReadResultSchema.parse(await this.#peer.request('host.browser.read', request))
  }

  async readScreenshot(input: BrowserScreenshotReadParams): Promise<BrowserScreenshotReadResult> {
    const request = browserScreenshotReadParamsSchema.parse(input)
    return browserScreenshotReadResultSchema.parse(await this.#peer.request('host.browser.readScreenshot', request))
  }

  async act(input: BrowserActParams): Promise<BrowserActResult> {
    const request = browserActParamsSchema.parse(input)
    return browserActResultSchema.parse(await this.#peer.request(
      'host.browser.act',
      request,
    ))
  }

  async validateAction(
    input: BrowserValidateActionParams,
  ): Promise<BrowserValidateActionResult> {
    const request = browserValidateActionParamsSchema.parse(input)
    return browserValidateActionResultSchema.parse(await this.#peer.request(
      'host.browser.validateAction',
      request,
    ))
  }

  async acquireControl(
    input: BrowserAcquireControlParams,
  ): Promise<BrowserAcquireControlResult> {
    const request = browserAcquireControlParamsSchema.parse(input)
    return browserAcquireControlResultSchema.parse(await this.#peer.request(
      'host.browser.acquireControl',
      request,
    ))
  }

  async releaseControl(
    input: BrowserReleaseControlParams,
  ): Promise<BrowserReleaseControlResult> {
    const request = browserReleaseControlParamsSchema.parse(input)
    return browserReleaseControlResultSchema.parse(await this.#peer.request(
      'host.browser.releaseControl',
      request,
    ))
  }

  async getState(sessionId: string): Promise<BrowserStateResult> {
    const request = browserSessionParamsSchema.parse({ sessionId })
    return browserStateResultSchema.parse(await this.#peer.request(
      'host.browser.getState',
      request,
    ))
  }

  async close(sessionId: string): Promise<BrowserCloseResult> {
    const request = browserSessionParamsSchema.parse({ sessionId })
    return browserCloseResultSchema.parse(await this.#peer.request(
      'host.browser.close',
      request,
    ))
  }
}
