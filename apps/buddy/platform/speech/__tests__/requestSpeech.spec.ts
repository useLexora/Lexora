import { expect, it } from 'vitest'
import { requestSpeech } from '../requestSpeech'
import { SpeechSession } from '../SpeechSession'
import { encodeSpeechWave } from '../speechWave'

it('delivers valid low-sample-rate WAV through the bounded speech session', async () => {
  const wave = encodeSpeechWave([new Uint8Array(new Float32Array(24000).buffer)])
  const header = new DataView(wave.buffer)
  header.setUint32(24, 8000, true)
  header.setUint32(28, 16000, true)
  const samples: number[] = []
  const ended = await new Promise<unknown>((resolve) => {
    const session = new SpeechSession({ id: 'c8f2b671-aed2-443d-9d6c-16b3f2254eb3', kind: 'speech.synthesize', provider: { id: 'fixture', revision: 'v1' }, text: 'Hello' }, (event) => {
      if (event.type === 'ended') {
        resolve(event)
      }
      else {
        if (event.payload.type === 'audio') {
          expect(event.payload.bytes.byteLength / 4 / event.payload.sampleRate).toBeLessThanOrEqual(2)
          samples.push(event.payload.bytes.byteLength / 4)
        }
        queueMicrotask(() => session.acknowledge(event.sequence))
      }
    })
    session.start(invocation => requestSpeech({ baseUrl: 'http://127.0.0.1:8000/v1', modelId: 'fixture', voice: 'fixture', headers: {}, request: async () => new Response(wave as Uint8Array<ArrayBuffer>) }, invocation))
  })
  expect(ended).toMatchObject({ status: 'completed' })
  expect(samples.reduce((sum, count) => sum + count, 0)).toBe(24000)
})

it.each([
  [401, 'invalid_api_key', 'UNAUTHORIZED'],
  [403, 'insufficient_permissions', 'FORBIDDEN'],
  [429, 'insufficient_quota', 'QUOTA_EXCEEDED'],
  [429, 'rate_limit_exceeded', 'BUSY'],
])('returns safe actionable model errors (%s, %s)', async (status, code, expected) => {
  await expect(requestSpeech({ baseUrl: 'http://127.0.0.1:8000/v1', modelId: 'fixture', voice: 'fixture', headers: {}, request: async () => Response.json({ error: { code, message: 'private account detail' } }, { status: Number(status) }) }, { id: 'test', kind: 'speech.synthesize', input: { text: 'Hello' }, signal: new AbortController().signal, ready: () => {}, event: () => {} })).rejects.toThrow(`SPEECH_SERVICE_${expected}`)
})
