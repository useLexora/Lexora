export class DiagnosticAdmission {
  #tokens = 512
  #updatedAt = performance.now()

  take(): boolean {
    const now = performance.now()
    this.#tokens = Math.min(512, this.#tokens + Math.max(0, now - this.#updatedAt) * 0.1)
    this.#updatedAt = now
    if (this.#tokens < 1)
      return false
    this.#tokens--
    return true
  }
}
