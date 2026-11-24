import process from 'node:process'

export function writeServiceStderr(value: string): void {
  try {
    const sink = process.stderr
    if (!sink?.writable)
      return
    sink.write(value, (error) => {
      if (!error || sink.listenerCount('error') !== 0)
        return
      // Node calls the failed write's callback before emitting its 'error'.
      function onClose() {
        sink.off('error', onError)
      }
      function onError(emitted: Error) {
        sink.off('close', onClose)
        if (emitted !== error && sink.listenerCount('error') === 0)
          throw emitted
      }
      sink.once('error', onError)
      sink.once('close', onClose)
    })
  }
  catch {
    // The inherited diagnostic handle can also be unavailable synchronously.
  }
}
