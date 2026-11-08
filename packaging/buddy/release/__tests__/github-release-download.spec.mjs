import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
// eslint-disable-next-line test/no-import-node-test -- 原生准备阶段尚未安装 workspace 测试框架。
import test from 'node:test'
import sandbox from '../../../../apps/buddy/platform/native/shellSandbox.json' with { type: 'json' }
import { downloadGithubReleaseAsset } from '../github-release-download.mjs'
import { prepareShellSandbox } from '../shell-sandbox.mjs'

const release = 'https://github.com/example/component/releases/download/v1.0.0'
const archive = 'component-1.0.0.tar.xz'
const api = 'https://api.github.com/repos/example/component/releases'

function fallback(context, failure, assets = [{ id: 7, name: archive }]) {
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === `${release}/${archive}`) {
      if (failure instanceof Error)
        throw failure
      return new Response('upstream unavailable', { status: failure })
    }
    if (url === `${api}/tags/v1.0.0`)
      return Response.json({ assets })
    assert.equal(url, `${api}/assets/7`)
    assert.equal(options.headers.Accept, 'application/octet-stream')
    return new Response('verified-source-candidate')
  })
}

test('returns the direct asset without consulting another source', async (context) => {
  context.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, `${release}/${archive}`)
    return new Response('direct-source')
  })
  assert.equal((await downloadGithubReleaseAsset(release, archive)).toString(), 'direct-source')
})

for (const status of [429, 502, 503, 504]) {
  test(`uses the same release asset through the official API after HTTP ${status}`, async (context) => {
    fallback(context, status, [{ id: 8, name: 'unrelated.tar.xz' }, { id: 7, name: archive, url: 'https://untrusted.example/file' }])
    assert.equal((await downloadGithubReleaseAsset(release, archive)).toString(), 'verified-source-candidate')
  })
}

for (const error of [new TypeError('network unavailable'), new DOMException('download timed out', 'TimeoutError')]) {
  test(`uses the official API after ${error.name}`, async (context) => {
    fallback(context, error)
    assert.equal((await downloadGithubReleaseAsset(release, archive)).toString(), 'verified-source-candidate')
  })
}

for (const status of [403, 404]) {
  test(`does not hide a permanent HTTP ${status} failure`, async (context) => {
    context.mock.method(globalThis, 'fetch', async (url) => {
      assert.equal(url, `${release}/${archive}`)
      return new Response('rejected', { status })
    })
    await assert.rejects(downloadGithubReleaseAsset(release, archive), new RegExp(`HTTP ${status}`))
  })
}

for (const assets of [[], [{ id: '7', name: archive }]]) {
  test(`rejects missing or invalid release asset identity: ${JSON.stringify(assets)}`, async (context) => {
    fallback(context, 504, assets)
    await assert.rejects(downloadGithubReleaseAsset(release, archive), /asset not found/)
  })
}

test('sends the optional token only to the official API', async (context) => {
  const previous = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'fixture-token'
  context.after(() => {
    if (previous === undefined)
      delete process.env.GH_TOKEN
    else
      process.env.GH_TOKEN = previous
  })
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === `${release}/${archive}`) {
      assert.equal(options.headers.Authorization, undefined)
      return new Response('unavailable', { status: 504 })
    }
    assert.equal(options.headers.Authorization, 'Bearer fixture-token')
    if (url === `${api}/tags/v1.0.0`)
      return Response.json({ assets: [{ id: 7, name: archive }] })
    assert.equal(url, `${api}/assets/7`)
    return new Response('authenticated-source')
  })
  assert.equal((await downloadGithubReleaseAsset(release, archive)).toString(), 'authenticated-source')
})

test('stops when the official API also fails', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 504 }))
  await assert.rejects(downloadGithubReleaseAsset(release, archive), /api\.github\.com.*HTTP 504/)
})

test('rejects unsupported release origins', async () => {
  await assert.rejects(downloadGithubReleaseAsset('https://untrusted.example/releases/download/v1.0.0', archive), /Unsupported GitHub release URL/)
})

test('rejects checksum-invalid fallback bytes before extraction or publication', { skip: process.platform !== 'linux' }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-sandbox-download-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  context.mock.method(globalThis, 'fetch', async (url) => {
    if (url === `${sandbox.release}/${sandbox.archive}`)
      return new Response('unavailable', { status: 504 })
    if (url === `https://api.github.com/repos/containers/bubblewrap/releases/tags/v${sandbox.version}`)
      return Response.json({ assets: [{ id: 7, name: sandbox.archive }] })
    assert.equal(url, 'https://api.github.com/repos/containers/bubblewrap/releases/assets/7')
    return new Response('corrupted archive')
  })
  await assert.rejects(prepareShellSandbox({ cwd: directory }), /download checksum mismatch/)
  const output = join(directory, 'apps/buddy', sandbox.resource.from)
  assert.equal(existsSync(join(output, `linux-${process.arch}`)), false)
  assert.deepEqual(readdirSync(output), [])
})
