import type { ApplicationDiagnostic, ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { DiagnosticAdmission } from '../../../shared/diagnostics/DiagnosticAdmission'

export class DiagnosticForwarder {
  readonly #admission = new DiagnosticAdmission()
  readonly #send: ApplicationDiagnosticReporter
  readonly #producerInstanceId = crypto.randomUUID()
  #dropped = 0
  #failed = 0
  #reported = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #disposed = false

  constructor(send: ApplicationDiagnosticReporter) {
    this.#send = send
  }

  record(event: ApplicationDiagnostic): void {
    if (this.#disposed)
      return
    if (!this.#admission.take()) {
      this.#dropped++
      this.#scheduleFlush()
      return
    }
    this.#deliver({ ...event, producerInstanceId: this.#producerInstanceId })
  }

  dispose(): void {
    if (this.#disposed)
      return
    this.#disposed = true
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#flush()
  }

  #deliver(event: ApplicationDiagnostic): void {
    try {
      this.#send(event)
    }
    catch {
      this.#failed++
      this.#scheduleFlush()
    }
  }

  #scheduleFlush(): void {
    if (this.#timer || this.#disposed)
      return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#flush()
    }, 5000)
    this.#timer.unref()
  }

  #flush(): void {
    if (this.#reported === this.#dropped + this.#failed)
      return
    this.#reported = this.#dropped + this.#failed
    this.#deliver({ event: 'recorder.loss', level: 'warn', producerInstanceId: this.#producerInstanceId, recorderLoss: { dropped: this.#dropped, failed: this.#failed } })
  }
}
