export function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }

  return new Promise(resolve => setTimeout(resolve, ms))
}

export function sleepUnref(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms)
    const maybeUnrefableTimeout = timeout as unknown as { unref?: () => void }
    maybeUnrefableTimeout.unref?.()
  })
}
