import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

export async function initialize({ configuration, resources }) {
  assert.equal(typeof process.versions.electron, 'string')
  assert.equal(resources.fixture, '/resources/fixture')
  assert.equal(await readFile(`${resources.fixture}/nested/payload.txt`, 'utf8'), configuration.challenge)
  assert.equal(JSON.parse(await readFile('/plugin/extension.json', 'utf8')).id, 'smoke.inference')
  for (const path of ['/plugin/write-probe', `${resources.fixture}/write-probe`])
    await assert.rejects(writeFile(path, 'denied'), { code: 'EROFS' })
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
