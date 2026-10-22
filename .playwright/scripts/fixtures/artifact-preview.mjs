import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { expect, useSyntheticCredentialStorage } from './electron.mjs'

export async function withArtifactPreview(buddy, options, verify) {
  const instance = await buddy.createInstance(options.label)
  const directory = path.join(instance.home, 'documents')
  await fs.mkdir(directory)
  const names = await options.prepare(directory)
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request)
      chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const publishing = requests.length === 1
    const delta = publishing
      ? { tool_calls: [{ index: 0, id: 'present-fixtures', type: 'function', function: { name: 'lexora_output_present', arguments: JSON.stringify({ paths: names }) } }] }
      : { content: 'Preview fixtures are ready.' }
    const common = { id: 'preview-fixture', model: 'preview-fixture', object: 'chat.completion.chunk', created: 1 }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: publishing ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const launch = await instance.launch()
    const { app, page, diagnostics } = launch
    await useSyntheticCredentialStorage(launch)
    await page.evaluate(async (baseUrl) => {
      await window.lexoraDesktop.settings.update({ desktop: { contextPanelMode: 'task', featureAnnouncementsEnabled: false } })
      const providers = window.lexoraDesktop.localChat.providers
      await providers.upsertCustom({ id: 'preview-fixture', displayName: 'Preview fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'preview-fixture', name: 'Preview fixture', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
      const stop = providers.onAuthChallenge((challenge) => {
        if (challenge.providerId === 'preview-fixture' && challenge.type === 'secret')
          void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
      })
      try {
        await providers.login('preview-fixture', 'api_key')
      }
      finally {
        stop()
      }
      await providers.setDefaultModel({ providerId: 'preview-fixture', modelId: 'preview-fixture', reasoning: null })
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    }, directory)
    await page.reload()
    await expect(page.locator('.desktop-workbench-area__tasks .tiptap:visible')).toBeVisible()
    await page.locator('.desktop-task-sidebar__spaces .desktop-task-sidebar__section-add').dispatchEvent('click')
    const dialog = page.locator('.desktop-space-dialog')
    await dialog.getByPlaceholder('输入空间名称').fill('文件产物验收')
    await dialog.getByRole('button', { name: '选择目录', exact: true }).click()
    await dialog.getByRole('button', { name: '确定', exact: true }).click()
    await expect(dialog).toBeHidden()
    await page.locator('.desktop-workbench-area__tasks .tiptap:visible').fill('Present the prepared files.')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    const outputs = page.locator('.buddy-artifact-collection__item')
    await expect(outputs).toHaveCount(names.length)
    await expect(page.getByText('Preview fixtures are ready.', { exact: true }).first()).toBeVisible()
    const output = name => outputs.filter({ has: page.locator('.buddy-artifact-collection__name').filter({ hasText: name }) })
    await verify({ ...launch, instance, directory, output, outputs, requests })
    expect(diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
  }
  finally {
    await new Promise(resolve => server.close(resolve))
  }
}

export function silentWave(seconds = 3) {
  const sampleRate = 8000
  const bytes = sampleRate * seconds * 2
  const buffer = Buffer.alloc(44 + bytes)
  buffer.write('RIFF')
  buffer.writeUInt32LE(36 + bytes, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(bytes, 40)
  return buffer
}
