import { describe, expect, it } from 'vitest'
import { applyDocumentInputPayload } from '../documentInputPayload'

const token = 'request-only-pdf-token'
const file = { name: 'report.pdf', data: 'JVBERi0xLjcK', mimeType: 'application/pdf' as const }
const files = new Map([[token, file]])

describe('pDF provider payloads', () => {
  it.each(['audio/wav', 'audio/mpeg', 'audio/mp4'] as const)('sends Xiaomi %s bytes as a MIME-qualified data URL', (mimeType) => {
    const media = { name: 'recording', data: 'AAECAw==', mimeType }
    const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: token }] }] }
    expect(applyDocumentInputPayload(payload, { api: 'openai-completions', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' }, new Map([[token, media]])))
      .toEqual({ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${mimeType};base64,${media.data}` } }] }] })
  })

  it('does not label M4A bytes as MP3 on an unimplemented audio route', () => {
    const media = { name: 'recording.m4a', data: 'AAECAw==', mimeType: 'audio/mp4' as const }
    const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: token }] }] }
    for (const baseUrl of ['https://api.openai.com/v1', 'https://example.test/v1', 'https://token-plan-cn.xiaomimimo.com.example.test/v1'])
      expect(() => applyDocumentInputPayload(payload, { api: 'openai-completions', baseUrl }, new Map([[token, media]]))).toThrow('MODEL_INPUT_UNSUPPORTED')
  })

  it.each(['audio/wav', 'audio/mpeg', 'video/mp4', 'video/webm'] as const)('sends native Gemini %s input without altering bytes', (mimeType) => {
    const media = { name: 'fixture', data: 'AAECAw==', mimeType }
    const payload = { contents: [{ role: 'user', parts: [{ text: token }] }] }
    expect(applyDocumentInputPayload(payload, { api: 'google-generative-ai', baseUrl: 'https://example.test' }, new Map([[token, media]])))
      .toEqual({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: media.data } }] }] })
    expect(() => applyDocumentInputPayload({ messages: [{ role: 'user', content: [{ text: token }] }] }, { api: 'anthropic-messages', baseUrl: 'https://example.test' }, new Map([[token, media]])))
      .toThrow('MODEL_INPUT_UNSUPPORTED')
  })

  it.each([{ mimeType: 'audio/wav', format: 'wav' }, { mimeType: 'audio/mpeg', format: 'mp3' }] as const)('sends OpenAI audio with the explicit $format encoding', ({ mimeType, format }) => {
    const media = { name: 'fixture', data: 'AAECAw==', mimeType }
    const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: token }] }] }
    expect(applyDocumentInputPayload(payload, { api: 'openai-completions', baseUrl: 'https://example.test' }, new Map([[token, media]])))
      .toEqual({ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: media.data, format } }] }] })
  })

  it('rejects the full Gemini inline request when accumulated history exceeds 20 MB', () => {
    const payload = { contents: [{ role: 'user', parts: [{ text: token }, { text: 'x'.repeat(20_000_000) }] }] }
    expect(() => applyDocumentInputPayload(payload, { api: 'google-generative-ai', baseUrl: 'https://example.test' }, files)).toThrow('MODEL_INPUT_TOO_LARGE')
  })

  it.each([
    { api: 'openai-responses', messages: 'input', parts: 'content', text: { type: 'input_text', text: token }, pdf: { type: 'input_file', filename: file.name, file_data: `data:application/pdf;base64,${file.data}` } },
    { api: 'openai-codex-responses', messages: 'input', parts: 'content', text: { type: 'input_text', text: token }, pdf: { type: 'input_file', filename: file.name, file_data: `data:application/pdf;base64,${file.data}`, detail: 'high' } },
    { api: 'openai-completions', messages: 'messages', parts: 'content', text: { type: 'text', text: token }, pdf: { type: 'file', file: { filename: file.name, file_data: `data:application/pdf;base64,${file.data}` } } },
    { api: 'anthropic-messages', messages: 'messages', parts: 'content', text: { type: 'text', text: token }, pdf: { type: 'document', title: file.name, source: { type: 'base64', media_type: 'application/pdf', data: file.data } } },
    { api: 'google-generative-ai', messages: 'contents', parts: 'parts', text: { text: token }, pdf: { inlineData: { mimeType: 'application/pdf', data: file.data } } },
  ])('uses the native $api file block and preserves all unrelated request data', ({ api, messages, parts, text, pdf }) => {
    const prompt = { ...text, text: 'Compare this PDF with the attached image.' }
    const image = { image_url: { url: 'data:image/png;base64,fixture' }, type: 'image_url' }
    const history = { role: 'assistant', [parts]: [{ ...text }] }
    const payload = { [messages]: [history, { role: 'user', [parts]: [prompt, image, { ...text, cache_control: { type: 'ephemeral' } }] }], service_tier: 'priority' }
    const original = structuredClone(payload)
    const result = applyDocumentInputPayload(payload, { api, baseUrl: 'https://example.test' }, files)
    expect(result).toEqual({
      ...payload,
      [messages]: [history, { role: 'user', [parts]: [prompt, image, { ...pdf, cache_control: { type: 'ephemeral' } }] }],
    })
    expect(payload).toEqual(original)
  })

  it('fails closed if an earlier transform drops, duplicates, or embeds a document placeholder', () => {
    for (const content of [[], [{ type: 'text', text: `prefix ${token}` }], [{ type: 'text', text: token }, { type: 'text', text: token }]]) {
      expect(() => applyDocumentInputPayload({ messages: [{ role: 'user', content }] }, { api: 'openai-completions', baseUrl: 'https://example.test' }, files))
        .toThrow('RESOURCE_MATERIALIZATION_FAILED')
    }
  })

  it('rejects unimplemented protocols and leaves requests without PDFs unchanged', () => {
    const payload = { input: [{ role: 'user', content: [{ type: 'input_text', text: token }] }] }
    expect(() => applyDocumentInputPayload(payload, { api: 'azure-openai-responses', baseUrl: 'https://example.test' }, files)).toThrow('RESOURCE_MATERIALIZATION_FAILED')
    expect(applyDocumentInputPayload(payload, { api: 'openai-codex-responses', baseUrl: 'https://example.test' }, new Map())).toBe(payload)
  })
})
