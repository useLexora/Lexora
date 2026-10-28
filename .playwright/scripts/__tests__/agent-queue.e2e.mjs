import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, useSyntheticCredentialStorage } from '../fixtures/electron.mjs'

for (const mode of ['idle-follow-up', 'native-wait-steer']) {
  test(`waiting parent accepts ${mode} while its child continues`, async ({ buddy }) => {
    const childGate = Promise.withResolvers()
    const parentRequests = []
    let npcId
    const server = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request)
        chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const text = JSON.stringify(payload.messages)
      let reply
      if (!text.includes('QUEUE_PARENT_ROLE')) {
        await childGate.promise
        reply = { text: 'CHILD_FINISHED_6942' }
      }
      else {
        parentRequests.push(payload)
        if (parentRequests.length === 1)
          reply = { tool: { operation: 'delegate', targetId: npcId, text: 'Return the child finding.' } }
        else if (parentRequests.length === 2 && mode === 'native-wait-steer')
          reply = { tool: { operation: 'wait', timeoutMs: 60000 } }
        else
          reply = { text: text.includes('CHILD_FINISHED_6942') ? 'PARENT_CONSUMED_CHILD_6942' : 'Parent is ready for additional input.' }
      }
      const common = { id: `reply-${parentRequests.length}`, created: 1, model: payload.model, object: 'chat.completion.chunk' }
      const delta = reply.tool
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${parentRequests.length}`, type: 'function', function: { name: 'lexora_agents', arguments: JSON.stringify(reply.tool) } }] }
        : { role: 'assistant', content: reply.text }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const instance = await buddy.createInstance(mode)
    const read = (sql) => {
      const database = new DatabaseSync(path.join(instance.home, 'buddy/buddy.sqlite3'), { readOnly: true })
      try {
        return database.prepare(sql).all()
      }
      finally { database.close() }
    }
    try {
      const desktop = await instance.launch()
      await useSyntheticCredentialStorage(desktop)
      const { page } = desktop
      npcId = await page.evaluate(async (baseUrl) => {
        const api = window.lexoraDesktop.localChat
        await api.providers.upsertCustom({ id: 'queue-fixture', displayName: 'Queue fixture', api: 'openai-completions', baseUrl, enabled: true, models: [{ id: 'queue-model', name: 'Queue model', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 1024 }] })
        const stop = api.providers.onAuthChallenge((challenge) => {
          if (challenge.providerId === 'queue-fixture' && challenge.type === 'secret')
            void api.providers.respondToAuth(challenge.challengeId, 'offline-fixture-key')
        })
        try {
          await api.providers.login('queue-fixture', 'api_key')
        }
        finally { stop() }
        await api.providers.setDefaultModel({ providerId: 'queue-fixture', modelId: 'queue-model', reasoning: null })
        const child = await api.buddies.create({ kind: 'npc', name: 'Queue child' })
        await api.buddies.update({ buddyId: child.id, expectedRevision: child.revision, settings: { ...child.settings, instructions: 'QUEUE_CHILD_ROLE', skills: { mode: 'none' }, tools: { mode: 'none' } } })
        const parent = await api.buddies.get('default')
        await api.buddies.update({ buddyId: parent.id, expectedRevision: parent.revision, settings: { ...parent.settings, instructions: 'QUEUE_PARENT_ROLE', skills: { mode: 'none' }, tools: { mode: 'none' }, npcIds: [child.id] } })
        return child.id
      }, `http://127.0.0.1:${server.address().port}/v1`)
      await page.reload()
      const composer = page.locator('.desktop-chat-composer__prosemirror:visible')
      await composer.fill('Delegate the child finding, then wait for my input.')
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect.poll(() => read('SELECT phase FROM execution_state JOIN runs ON runs.id=run_id WHERE parent_run_id IS NULL')[0]?.phase).toBe('waiting')
      expect(parentRequests).toHaveLength(2)
      const parentId = read('SELECT id FROM runs WHERE parent_run_id IS NULL')[0].id
      const inputs = mode === 'native-wait-steer' ? ['INPUT_A_517', 'INPUT_C_517', 'INPUT_B_517'] : ['INPUT_A_517']
      for (const input of inputs) {
        if (mode === 'native-wait-steer') {
          await page.evaluate(async ({ text, parentId }) => {
            const api = window.lexoraDesktop.localChat
            const run = await api.runs.get(parentId)
            const source = await api.composerDrafts.open({
              draftId: crypto.randomUUID(),
              scope: { kind: 'conversation_branch', conversationId: run.conversationId, branchId: run.branchId },
              initialContent: { version: 1, body: [{ type: 'paragraph', content: [] }], panelResourceIds: [] },
              initialExecutionConfig: { approvalPolicy: run.approvalPolicy, executionProfile: run.executionProfile },
              initialModelSelection: null,
            })
            const draft = await api.composerDrafts.save({
              draftId: source.draftId,
              expectedRevision: source.revision,
              content: { version: 1, body: [{ type: 'paragraph', content: [{ type: 'text', text }] }], panelResourceIds: [] },
              executionConfig: source.executionConfig,
              modelSelection: source.modelSelection,
            })
            await api.chat.enqueue({ draftId: draft.draftId, expectedRevision: draft.revision, requestId: crypto.randomUUID() })
          }, { text: input, parentId })
        }
        else {
          await composer.fill(input)
          await page.locator('.desktop-chat-composer__actions').getByRole('button', { name: '补充当前工作', exact: true }).click()
        }
      }
      if (mode === 'native-wait-steer') {
        await expect(page.locator('.chat-message-queue__row')).toHaveCount(3)
        expect(parentRequests).toHaveLength(2)
        await page.locator('.chat-message-queue__row').filter({ hasText: 'INPUT_B_517' }).getByRole('button', { name: '立即发送', exact: true }).click()
      }
      await expect.poll(() => parentRequests.length).toBe(2 + inputs.length)
      await expect(page.locator('.chat-message-queue__row')).toHaveCount(0)
      expect(parentRequests.slice(2).map(payload => JSON.stringify(payload.messages.filter(message => message.role === 'user').at(-1)))).toEqual((mode === 'native-wait-steer' ? ['INPUT_B_517', 'INPUT_A_517', 'INPUT_C_517'] : inputs).map(input => expect.stringContaining(input)))
      expect(read('SELECT DISTINCT run_id FROM chat_queue')).toEqual([{ run_id: parentId }])
      expect(read('SELECT status FROM runs WHERE parent_run_id IS NOT NULL')).toEqual([{ status: 'running' }])
      childGate.resolve()
      await expect.poll(() => read('SELECT status FROM runs').map(row => row.status)).toEqual(['completed', 'completed'])
      expect(JSON.stringify(parentRequests.at(-1))).toContain('CHILD_FINISHED_6942')
      expect(read('SELECT kind FROM execution_mailbox_receipts WHERE kind=\'consumed\'')).toEqual([{ kind: 'consumed' }])
      await expect(page.getByText('PARENT_CONSUMED_CHILD_6942', { exact: true })).toBeVisible()
    }
    finally {
      childGate.resolve()
      await instance.stop()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })
}
