import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '../fixtures/electron.mjs'

const { PhotonImage } = createRequire(new URL('../../../apps/buddy/package.json', import.meta.url))('@silvia-odwyer/photon-node')

for (const dimensions of [[2, 1], [2400, 1200]]) {
  test(`image ${dimensions.join('x')} keeps its original and stable model input across desktop restart`, async ({ buddy }) => {
    const requests = []
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end()
        return
      }
      const chunks = []
      for await (const chunk of request)
        chunks.push(chunk)
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const common = { id: `image-${requests.length}`, model: 'image-fixture', object: 'chat.completion.chunk', created: 1 }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: 'Image reference received.' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const instance = await buddy.createInstance('image-input')
    try {
      let application = await instance.launch()
      await useSyntheticCredentialStorage(application)
      await application.page.evaluate(async (baseUrl) => {
        const providers = window.lexoraDesktop.localChat.providers
        await providers.upsertCustom({
          id: 'image-fixture',
          displayName: 'Image fixture',
          api: 'openai-completions',
          baseUrl,
          enabled: true,
          models: [{ id: 'image-fixture', name: 'Image fixture', input: ['text', 'image'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }],
        })
        const stop = providers.onAuthChallenge((challenge) => {
          if (challenge.providerId === 'image-fixture' && challenge.type === 'secret')
            void providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
        })
        try {
          await providers.login('image-fixture', 'api_key')
        }
        finally {
          stop()
        }
        await providers.setDefaultModel({ providerId: 'image-fixture', modelId: 'image-fixture', reasoning: null })
      }, `http://127.0.0.1:${server.address().port}/v1`)
      await application.page.reload()
      const editor = application.page.locator('.desktop-chat-composer__prosemirror:visible')
      await expect(editor).toBeVisible()
      const pixels = new PhotonImage(new Uint8Array(dimensions[0] * dimensions[1] * 4).fill(255), ...dimensions)
      let image
      try {
        image = Buffer.from(pixels.get_bytes()).toString('base64')
      }
      finally {
        pixels.free()
      }
      await application.page.evaluate((data) => {
        const transfer = new DataTransfer()
        transfer.items.add(new File([Uint8Array.from(atob(data), character => character.charCodeAt(0))], 'image-fixture.png', { type: 'image/png' }))
        document.querySelector('.desktop-chat-composer-wrap').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
      }, image)
      const card = application.page.locator('.composer-resource-strip__card')
      await expect(card).toHaveCount(1)
      await expect(card.locator('small')).toHaveCount(0)
      await editor.fill('Inspect the attached image.')
      await application.page.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect.poll(() => completedRuns(instance.home)).toBe(1)
      expect(requests).toHaveLength(1)
      const sentImages = imageUrls(requests[0])
      expect(sentImages).toHaveLength(1)
      const sentData = sentImages[0].split(',')[1]
      const decoded = PhotonImage.new_from_byteslice(Buffer.from(sentData, 'base64'))
      try {
        expect(decoded.get_width()).toBe(Math.min(dimensions[0], 2000))
        expect(decoded.get_height()).toBe(dimensions[1] * Math.min(1, 2000 / dimensions[0]))
      }
      finally {
        decoded.free()
      }
      const originalPath = readDatabase(instance.home, database => database.prepare('SELECT stored_path FROM attachments WHERE message_id IS NOT NULL LIMIT 1').get().stored_path)
      expect((await fs.readFile(originalPath)).toString('base64')).toBe(image)
      const firstJournal = await sessionJournal(instance.home)
      expect(firstJournal).toContain('"buddyInput"')
      expect(firstJournal).not.toContain(image)
      expect(firstJournal).not.toContain(sentData)
      expect(firstJournal).not.toContain('[Image omitted:')

      await instance.stop()
      application = await instance.launch()
      await useSyntheticCredentialStorage(application)
      await application.page.reload()
      const resumed = application.page.locator('.desktop-chat-composer__prosemirror:visible')
      await expect(resumed).toBeVisible()
      await resumed.fill('Describe the same image again.')
      await application.page.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect.poll(() => completedRuns(instance.home)).toBe(2)
      expect(requests).toHaveLength(2)
      expect(imageUrls(requests[1])).toEqual(sentImages)
      expect((await fs.readFile(originalPath)).toString('base64')).toBe(image)
      const journal = await sessionJournal(instance.home)
      expect(journal.startsWith(firstJournal)).toBe(true)
      expect(journal).not.toContain(image)
      expect(journal).not.toContain(sentData)
      expect(journal).not.toContain('[Image omitted:')
      const references = journal.trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.type === 'message' && entry.message.buddyInput)
      expect(references).toHaveLength(2)
      expect(new Set(references.map(entry => entry.message.buddyInput.messageId)).size).toBe(2)
      expect(application.diagnostics.console.filter(item => item.type === 'pageerror')).toEqual([])
    }
    finally {
      await instance.stop()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })
}

async function useSyntheticCredentialStorage({ app, page }) {
  await app.evaluate(({ app, safeStorage }) => {
    if (app.getName() !== 'Lexora Buddy Test')
      throw new Error('Synthetic credentials require an isolated test instance')
    Object.defineProperties(safeStorage, {
      isEncryptionAvailable: { configurable: true, value: () => true },
      getSelectedStorageBackend: { configurable: true, value: () => 'offline-fixture' },
      encryptString: { configurable: true, value: value => Buffer.from(`offline-fixture:${value}`) },
      decryptString: {
        configurable: true,
        value: (value) => {
          const serialized = value.toString('utf8')
          if (!serialized.startsWith('offline-fixture:'))
            throw new Error('Unexpected credential in isolated fixture')
          return serialized.slice('offline-fixture:'.length)
        },
      },
    })
  })
  await page.evaluate(() => window.lexoraDesktop.localChat.runtime.restart())
  await expect.poll(async () => (await page.evaluate(() => window.lexoraDesktop.localChat.runtime.getStatus())).status).toBe('ready')
}

function readDatabase(home, read) {
  const database = new DatabaseSync(path.join(home, 'buddy/buddy.sqlite3'), { readOnly: true })
  try {
    return read(database)
  }
  finally {
    database.close()
  }
}

function completedRuns(home) {
  return readDatabase(home, database => database.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = ?').get('completed').count)
}

async function sessionJournal(home) {
  const file = readDatabase(home, database => database.prepare('SELECT pi_session_file FROM runs ORDER BY started_at DESC LIMIT 1').get().pi_session_file)
  return fs.readFile(file, 'utf8')
}

function imageUrls(request) {
  return request.messages.filter(message => message.role === 'user')
    .flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image_url').map(block => block.image_url.url) : [])
}
