import type { SyncTransport } from '../sync/SyncAdapter'
import type { SpeechInvocation } from './SpeechBackend'
import { z } from 'zod'
import { readLimitedResponse } from '../sync/SyncAdapter'
import { speechCapabilities } from './speechCapabilities'
import { speechRequestError } from './speechRequestError'
import { decodeSpeechWave, encodeSpeechWave } from './speechWave'

export async function requestSpeech(options: {
  baseUrl: string
  modelId: string
  headers: Record<string, string>
  language?: string
  voice?: string
  rate?: number
  request: SyncTransport
}, invocation: SpeechInvocation): Promise<void> {
  const capabilities = speechCapabilities(options.baseUrl, invocation.kind)
  const headers = new Headers(options.headers)
  let url = options.baseUrl.replace(/\/+$/, '')
  let body: Uint8Array
  await invocation.ready()
  if (invocation.kind === 'speech.transcribe') {
    if (!invocation.chunks)
      throw new Error('SPEECH_INPUT_INVALID')
    const chunks: Uint8Array[] = []
    let length = 0
    for await (const chunk of invocation.chunks) {
      invocation.signal.throwIfAborted()
      length += chunk.length
      if (length > 16000 * 4 * 600)
        throw new Error('SPEECH_INPUT_OVERFLOW')
      chunks.push(chunk)
    }
    if (!length)
      throw new Error('SPEECH_AUDIO_EMPTY')
    const form = new FormData()
    form.set('model', options.modelId)
    if (options.language && capabilities.supportsLanguageSelection)
      form.set('language', options.language)
    form.set('file', new Blob([encodeSpeechWave(chunks) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'speech.wav')
    const request = new Request(url, { method: 'POST', body: form })
    headers.set('Content-Type', request.headers.get('content-type')!)
    body = new Uint8Array(await request.arrayBuffer())
    url += '/audio/transcriptions'
  }
  else {
    const { text } = z.object({ text: z.string().min(1).max(16000) }).parse(invocation.input)
    const voice = options.voice?.trim()
    if (!voice)
      throw new Error('SPEECH_VOICE_REQUIRED')
    headers.set('Content-Type', 'application/json')
    body = new TextEncoder().encode(JSON.stringify({ model: options.modelId, input: text, voice, ...(capabilities.supportsRate ? { speed: options.rate ?? 1 } : {}), response_format: 'wav' }))
    url += '/audio/speech'
  }
  let response: Response
  try {
    response = await options.request(url, { method: 'POST', headers: Object.fromEntries(headers), body, signal: invocation.signal })
  }
  catch {
    invocation.signal.throwIfAborted()
    throw new Error('SPEECH_SERVICE_DISCONNECTED')
  }
  if (!response.ok)
    throw await speechRequestError(response)
  if (invocation.kind === 'speech.transcribe') {
    const bytes = await readLimitedResponse(response, 256 * 1024)
    const { text } = z.object({ text: z.string().max(16000) }).parse(JSON.parse(new TextDecoder().decode(bytes)))
    await invocation.event({ type: 'transcript', segmentId: 'result', revision: 0, text, final: true }, new Uint8Array(), invocation.signal)
    return
  }
  const bytes = await readLimitedResponse(response, 64 * 1024 * 1024)
  const audio = decodeSpeechWave(bytes)
  const chunkBytes = Math.min(64 * 1024, audio.sampleRate * 4)
  let sequence = 0
  for (let offset = 0; offset < audio.samples.length; offset += chunkBytes) {
    invocation.signal.throwIfAborted()
    await invocation.event({ type: 'audio', sequence: sequence++, sampleFormat: 'f32le', sampleRate: audio.sampleRate, channels: 1 }, audio.samples.subarray(offset, offset + chunkBytes), invocation.signal)
  }
}
