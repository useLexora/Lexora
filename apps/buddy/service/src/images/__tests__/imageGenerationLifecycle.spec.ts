import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import type { ServerResponse } from 'node:http'
import type { BuddyProjectedEvent } from '../../agent/events/projectPiEvent'
import type { CreatedBuddySession } from '../../agent/sessions/createBuddySession'
import type { ImageOperationEvent } from '../ImageOperationLifecycle'
import { Buffer } from 'node:buffer'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { createPiEventProjectionState, projectPiEvent } from '../../agent/events/projectPiEvent'
import { createIsolatedBuddySession } from '../../agent/sessions/__tests__/isolatedBuddySession'
import { createImageGenerationExtension } from '../imageGenerationExtension'
import { ImageGenerationService } from '../ImageGenerationService'
import { IMAGE_GENERATION_TOOL_NAME } from '../imageGenerationToolContract'
import { OpenAiImageGenerationService } from '../OpenAiImageGenerationService'

describe('image generation through the Pi session', () => {
  it.each(['incomplete', 'cancel', 'json-disconnect'] as const)('settles a mixed image batch and releases its HTTP requests on %s', async (ending) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-image-session-')))
    const codex = ending !== 'json-disconnect'
    const requests: string[] = []
    const closed: string[] = []
    let pendingResponse: ServerResponse | undefined
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => body += chunk)
      request.on('end', () => {
        const prompt = JSON.parse(body).input[0].content[0].text as string
        requests.push(prompt)
        response.on('close', () => closed.push(prompt))
        response.writeHead(200, { 'content-type': codex ? 'text/event-stream' : 'application/json', 'x-request-id': 'req_image_fixture' })
        if (prompt === 'success') {
          const result = {
            id: 'response-1',
            status: 'completed',
            output: [{ type: 'image_generation_call', status: 'completed', result: png.toString('base64') }],
          }
          if (codex)
            response.write(`data: ${JSON.stringify({ type: 'response.completed', response: result })}\n\n`)
          else
            response.end(JSON.stringify(result))
        }
        else if (prompt === 'failure') {
          const result = { status: 'failed', error: { code: 'provider_failure' } }
          if (codex)
            response.write(`data: ${JSON.stringify({ type: 'response.failed', response: result })}\n\n`)
          else
            response.end(JSON.stringify(result))
        }
        else {
          pendingResponse = response
          response.write(codex ? ': waiting\n\n' : '{"status":"completed","output":[')
          if (ending === 'incomplete')
            response.end()
        }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    let created: CreatedBuddySession | undefined
    let service: ImageGenerationService | undefined
    let pending: Promise<void> | undefined
    try {
      const credentials = new InMemoryCredentialStore()
      const runtime = await ModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false })
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Expected a loopback server')
      const provider = codex ? 'openai-codex' : 'openai'
      const api = codex ? 'openai-codex-responses' : 'openai-responses'
      const model = { ...runtime.getModels(provider).find(model => model.api === api)!, baseUrl: `http://127.0.0.1:${address.port}` }
      const token = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.fixture`
      await credentials.modify(model.provider, async () => codex
        ? { type: 'oauth', access: token, refresh: 'fixture-refresh', expires: Date.now() + 3_600_000 }
        : { type: 'api_key', key: 'fixture-key' })
      let turns = 0
      vi.spyOn(runtime, 'streamSimple').mockImplementation(target => assistantResponse(target, turns++ === 0))
      const source = { materializeConversationImages: async () => ({ images: [], records: [] }) }
      const published: string[] = []
      service = new ImageGenerationService({
        conversationId: 'conversation-1',
        cwd: root,
        grants: [],
        attachmentService: source,
        artifactService: {
          ...source,
          async registerGeneratedImages(input) {
            expect(input.images).toEqual([{ bytes: new Uint8Array(png), mimeType: 'image/png' }])
            published.push(input.outputPath)
            return [{ id: 'artifact-1' }]
          },
        },
        imageGenerationGateway: new OpenAiImageGenerationService({
          modelRuntime: runtime,
          fetch: async (url, init) => {
            expect(url).toBe(`${model.baseUrl}${codex ? '/codex' : ''}/responses`)
            const response = await fetch(url, init)
            if (ending === 'json-disconnect' && JSON.parse(String(init?.body)).input[0].content[0].text === 'pending')
              pendingResponse!.destroy()
            return response
          },
        }),
      })
      const operations: ImageOperationEvent[] = []
      service.onDidChange(event => operations.push(event))
      created = await createIsolatedBuddySession({
        agentDir: join(root, 'agent'),
        canonicalRoot: root,
        cwd: root,
        conversationsDirectory: join(root, 'conversations'),
        conversationId: 'conversation-1',
        branchId: 'branch-1',
        approvalPolicy: 'policy',
        executionProfile: 'workspace_write',
        model,
        modelRuntime: runtime,
        thinkingLevel: 'off',
        resources: { skillReadRoots: [], skillReferences: [], approvedSkills: [], context: { agentsFiles: [], diagnostics: [] }, directoryContext: '', revision: 'empty' },
        inProcessExtensions: [createImageGenerationExtension({ getRunId: () => 'run-1', service })],
      })
      created.session.setActiveToolsByName([IMAGE_GENERATION_TOOL_NAME])
      const state = createPiEventProjectionState({ canonicalRoot: root })
      const projected: BuddyProjectedEvent[] = []
      created.session.subscribe(event => projected.push(...projectPiEvent(event, state).events))
      pending = created.session.prompt('Generate the fixture images')
      void pending.catch(() => {})
      if (ending === 'cancel') {
        await vi.waitFor(() => {
          expect(requests).toContain('pending')
          expect(operations.filter(event => event.phase === 'settled')).toHaveLength(2)
        })
        await created.session.abort()
      }
      await pending
      await service.dispose()
      expect(requests.toSorted()).toEqual(['failure', 'pending', 'success'])
      await vi.waitFor(() => expect(closed.toSorted()).toEqual(requests.toSorted()))
      expect(published).toEqual(['success.png'])
      expect(operations.filter(event => event.phase === 'settled').map(event => event.outcome).toSorted()).toEqual(
        ending === 'cancel' ? ['cancelled', 'completed', 'failed'] : ['completed', 'failed', 'failed'],
      )
      expect(projected.filter(event => event.type === 'tool.completed')).toEqual(expect.arrayContaining([
        expect.objectContaining({ payload: expect.objectContaining({ toolCallId: 'image-success', isError: false, presentation: expect.objectContaining({ card: 'image', status: 'completed', generatedCount: 1 }) }) }),
        expect.objectContaining({ payload: expect.objectContaining({ toolCallId: 'image-failure', isError: true, presentation: expect.objectContaining({ card: 'image', status: 'failed', generatedCount: 0 }) }) }),
        expect.objectContaining({ payload: expect.objectContaining({ toolCallId: 'image-pending', isError: true, presentation: expect.objectContaining({ card: 'image', status: 'failed' }) }) }),
      ]))
      expect(projected.filter(event => event.type === 'output.produced')).toHaveLength(1)
      expect(state.toolCalls.size).toBe(0)
      if (ending !== 'cancel') {
        expect(created.session.messages.filter(message => message.role === 'toolResult').at(-1)).toMatchObject({
          isError: true,
          details: { code: 'IMAGE_GENERATION_INCOMPLETE', diagnostic: { requestId: 'req_image_fixture' } },
          content: [{ type: 'text', text: expect.stringContaining('do not automatically repeat') }],
        })
      }
    }
    finally {
      server.closeAllConnections()
      await created?.session.abort()
      await pending?.catch(() => {})
      await service?.dispose()
      await created?.shutdown('quit')
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })
})

function assistantResponse(model: Model<Api>, tools: boolean) {
  const message: AssistantMessage = {
    api: model.api,
    model: model.id,
    provider: model.provider,
    role: 'assistant',
    timestamp: Date.now(),
    stopReason: tools ? 'toolUse' : 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: tools
      ? ['success', 'failure', 'pending'].map(prompt => ({ type: 'toolCall', id: `image-${prompt}`, name: IMAGE_GENERATION_TOOL_NAME, arguments: { prompt, outputPath: `${prompt}.png` } }))
      : [{ type: 'text', text: 'Finished' }],
  }
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => stream.push({ type: 'done', reason: tools ? 'toolUse' : 'stop', message }))
  return stream
}
