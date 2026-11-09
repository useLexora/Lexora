import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- CI 环境准备使用 Node 测试入口。
import test from 'node:test'
import { prepareTestElectron } from '../prepare-test-electron.mjs'

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-electron-preparation-test-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('rejects checksum-invalid bytes before extracting or publishing Electron', async (context) => {
  const output = join(fixture(context), 'electron')
  context.mock.method(globalThis, 'fetch', async () => new Response('invalid-archive'))
  await assert.rejects(prepareTestElectron(output), /did not match/)
  assert.equal(existsSync(output), false)
})

test('rejects checksum-invalid API fallback bytes before publishing Electron', async (context) => {
  const output = join(fixture(context), 'electron')
  let archive
  context.mock.method(globalThis, 'fetch', async (url) => {
    if (url.startsWith('https://github.com/electron/electron/releases/download/')) {
      archive = url.split('/').at(-1)
      return new Response('unavailable', { status: 504 })
    }
    if (url.startsWith('https://api.github.com/repos/electron/electron/releases/tags/'))
      return Response.json({ assets: [{ id: 7, name: archive }] })
    assert.equal(url, 'https://api.github.com/repos/electron/electron/releases/assets/7')
    return new Response('invalid-archive')
  })
  await assert.rejects(prepareTestElectron(output), /did not match/)
  assert.equal(existsSync(output), false)
})

test('does not overwrite an existing destination', async (context) => {
  const output = fixture(context)
  const existing = join(output, 'existing.txt')
  writeFileSync(existing, 'preserved')
  await assert.rejects(prepareTestElectron(output), /destination already exists/)
  assert.equal(readFileSync(existing, 'utf8'), 'preserved')
})
