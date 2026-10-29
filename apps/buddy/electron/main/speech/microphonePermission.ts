const leases = new Map<number, () => boolean>()
export function microphoneAllowed(webContentsId: number): boolean {
  return leases.get(webContentsId)?.() ?? false
}
export function registerMicrophoneLease(webContentsId: number, allowed: () => boolean): () => void {
  leases.set(webContentsId, allowed)
  return () => {
    if (leases.get(webContentsId) === allowed)
      leases.delete(webContentsId)
  }
}
