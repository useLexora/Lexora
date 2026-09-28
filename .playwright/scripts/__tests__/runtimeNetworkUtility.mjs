import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { startRuntimeNetwork } from '../../../apps/buddy/service/src/network/runtimeNetwork.ts'

async function run() {
  const stop = startRuntimeNetwork()
  const start = performance.now()
  const before = process.cpuUsage()
  let failure
  try {
    await fetch('https://fixture.invalid/request', { signal: AbortSignal.timeout(150) })
  }
  catch (error) {
    failure = { name: error.name, code: error.cause?.code }
  }
  const settled = performance.now()
  const atIdle = process.cpuUsage()
  await delay(400)
  const idleUsage = process.cpuUsage(atIdle)
  const total = process.cpuUsage(before)
  try {
    const response = await fetch('http://fixture.invalid/stream', { signal: AbortSignal.timeout(2000) })
    const stream = await response.text()
    const websocket = await new Promise((resolve, reject) => {
      const socket = new WebSocket('ws://fixture.invalid/socket')
      const timeout = setTimeout(() => {
        socket.close()
        reject(new Error('WebSocket timed out'))
      }, 2000)
      socket.addEventListener('error', () => {
        clearTimeout(timeout)
        reject(new Error('WebSocket failed'))
      }, { once: true })
      socket.addEventListener('message', (event) => {
        clearTimeout(timeout)
        socket.close()
        resolve(event.data)
      }, { once: true })
    })
    const abort = new AbortController()
    const pending = await fetch('http://fixture.invalid/pending', { signal: abort.signal })
    const reader = pending.body.getReader()
    await reader.read()
    abort.abort()
    let cancelled = false
    try {
      await reader.read()
    }
    catch (error) { cancelled = error.name === 'AbortError' }
    return { versions: { electron: process.versions.electron, node: process.versions.node, undici: process.versions.undici }, failure, settleMs: settled - start, totalCpuMs: (total.user + total.system) / 1000, idleCpuMs: (idleUsage.user + idleUsage.system) / 1000, stream, responseCompatible: response instanceof Response, websocket, cancelled }
  }
  finally { await stop() }
}

run().then(result => process.parentPort.postMessage(result), error => process.parentPort.postMessage({ error: error.message }))
