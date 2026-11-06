import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

export async function initialize({ configuration, resources, resourceFiles }) {
  assert.equal(typeof process.versions.electron, 'string')
  const payload = resourceFiles?.fixture?.['nested/payload.txt'] ?? join(resources.fixture, 'nested/payload.txt')
  assert.equal(await readFile(payload, 'utf8'), configuration.challenge)
  assert.equal(JSON.parse(await readFile(new URL('../extension.json', import.meta.url), 'utf8')).id, 'smoke.inference')
  if (process.platform === 'linux') {
    assert.equal(resources.fixture, '/resources/fixture')
    for (const path of ['/plugin/write-probe', join(resources.fixture, 'write-probe')])
      await assert.rejects(writeFile(path, 'denied'), { code: 'EROFS' })
  }
  return {
    start(capability, input, invocation) {
      assert.equal(capability, 'echo')
      assert.equal(input.challenge, configuration.challenge)
      const chunks = []
      return {
        write(bytes) {
          chunks.push(Buffer.from(bytes))
        },
        async finish() {
          await invocation.emitAsync({ challenge: configuration.challenge, chunks: chunks.length }, Buffer.concat(chunks))
        },
      }
    },
  }
}
