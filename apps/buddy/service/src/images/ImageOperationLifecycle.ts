import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { ArtifactBatchReceipt } from '../artifacts/ArtifactService'
import { randomUUID } from 'node:crypto'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { ArtifactPublicationError } from '../artifacts/ArtifactService'

export interface ImageOperationEvent {
  readonly revision: number
  readonly operationId: string
  readonly conversationId: string
  readonly kind: 'generation' | 'transform'
  readonly phase: 'preparing' | 'processing' | 'result-received' | 'publishing' | 'settled'
  readonly outcome?: 'completed' | 'cancelled' | 'partial' | 'failed'
  readonly cancellationRequested: boolean
  readonly artifactIds: readonly string[]
  readonly publication?: ArtifactBatchReceipt
  readonly errorCode?: 'IMAGE_OPERATION_FAILED'
}

export class ImageOperationLifecycle {
  readonly #changes = new Emitter<ImageOperationEvent>(() => console.error('IMAGE_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly #pending = new Set<Promise<unknown>>()
  #revision = 0
  #disposed = false

  run<T>(input: { conversationId: string, kind: ImageOperationEvent['kind'], signal?: AbortSignal }, operation: (progress: (phase: Exclude<ImageOperationEvent['phase'], 'settled'>) => void) => Promise<{ value: T, artifactIds: readonly string[] }>): Promise<T> {
    if (this.#disposed)
      return Promise.reject(new Error('IMAGE_SERVICE_STOPPED'))
    const operationId = randomUUID()
    const publish = (details: Pick<ImageOperationEvent, 'phase' | 'outcome' | 'publication' | 'errorCode'> & { artifactIds?: readonly string[] }) => {
      this.#changes.fire(copyEventSnapshot({ revision: ++this.#revision, operationId, conversationId: input.conversationId, kind: input.kind, cancellationRequested: input.signal?.aborted ?? false, artifactIds: [], ...details }))
    }
    const pending = Promise.resolve().then(async () => {
      publish({ phase: 'preparing' })
      try {
        const result = await operation(phase => publish({ phase }))
        publish({ phase: 'settled', outcome: 'completed', artifactIds: result.artifactIds })
        return result.value
      }
      catch (error) {
        const publication = error instanceof ArtifactPublicationError ? error.receipt : undefined
        const outcome = publication ? publication.outcome === 'partial' ? 'partial' : 'failed' : input.signal?.aborted ? 'cancelled' : 'failed'
        publish({ phase: 'settled', outcome, publication, artifactIds: publication?.artifactIds ?? [], errorCode: 'IMAGE_OPERATION_FAILED' })
        throw error
      }
    }).finally(() => this.#pending.delete(pending))
    this.#pending.add(pending)
    return pending
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    await Promise.allSettled([...this.#pending])
    this.#changes.dispose()
  }
}

export function observeImageDiagnostics(source: Pick<ImageOperationLifecycle, 'onDidChange'>, report: ApplicationDiagnosticReporter) {
  const record = safeDiagnosticReporter(report)
  return source.onDidChange((event) => {
    record({
      event: `image.${event.kind}.${event.phase.replaceAll('-', '_')}${event.outcome ? `.${event.outcome}` : ''}`,
      level: event.outcome === 'failed' || event.outcome === 'partial' ? 'warn' : 'info',
      conversationId: event.conversationId,
      operationId: event.operationId,
      revision: event.revision,
      count: event.artifactIds.length,
      errorCode: event.errorCode,
    })
  })
}
