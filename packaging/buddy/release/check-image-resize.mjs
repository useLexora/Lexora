import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import process from 'node:process'
import { Worker } from 'node:worker_threads'

async function main() {
  const input = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4n6YERAwQCgAuRgYdRC83+AAAAABJRU5ErkJggg==', 'base64')
  const worker = new Worker(new URL('./assets/image-resize-worker.js', import.meta.url))
  try {
    const response = once(worker, 'message')
    worker.postMessage({ inputBytes: input, mimeType: 'image/png', options: { maxWidth: 1, maxHeight: 1 } })
    const [{ result, error }] = await response
    assert.ok(result?.wasResized, error ?? 'Packaged image worker failed to resize PNG')
    assert.deepEqual([result.originalWidth, result.originalHeight, result.width, result.height], [2, 2, 1, 1])
    assert.equal(result.mimeType, 'image/png')
    const output = Buffer.from(result.data, 'base64')
    assert.equal(output.readUInt32BE(16), 1)
    assert.equal(output.readUInt32BE(20), 1)
  }
  finally {
    await worker.terminate()
  }
}

process.exitCode = 1
main().then(() => {
  process.exitCode = 0
}).catch(error => console.error(error))
