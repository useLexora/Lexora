import { afterEach, expect, it, vi } from 'vitest'
import { chooseSystemVoice, SystemSpeechPlayback, systemVoices } from '../audio/SystemSpeechPlayback'
import { speechText } from '../speechText'

const voice = (voiceURI: string, lang: string, localService = true) => ({ voiceURI, lang, name: voiceURI, localService, default: false }) as SpeechSynthesisVoice
function fixture(voices = [voice('english', 'en-US'), voice('chinese', 'zh-CN')]) {
  const spoken: SpeechSynthesisUtterance[] = []
  vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} })
  const synthesis = { getVoices: () => voices, speak: (utterance: SpeechSynthesisUtterance) => {
    spoken.push(utterance)
  }, cancel: vi.fn() } as unknown as SpeechSynthesis
  return { synthesis, spoken, playback: new SystemSpeechPlayback(synthesis) }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('uses a matching local voice and excludes remote voices from the system option', () => {
  const { synthesis } = fixture([voice('remote', 'zh-CN', false), voice('english', 'en-US'), voice('chinese', 'zh-CN')])
  const voices = systemVoices(synthesis)
  expect(voices.map(item => item.voiceURI)).toEqual(['english', 'chinese'])
  expect(chooseSystemVoice(voices, 'missing', 'zh-CN')?.voiceURI).toBe('chinese')
  expect(chooseSystemVoice(voices, 'english', 'zh-CN')?.voiceURI).toBe('english')
})

it('starts, completes and clears the timer after playback', async () => {
  const { playback, spoken } = fixture()
  vi.useFakeTimers()
  const started = vi.fn()
  const done = playback.play('Hello', { language: 'en-US', rate: 1.2 }, started)
  expect(spoken[0]).toMatchObject({ text: 'Hello', rate: 1.2, voice: { voiceURI: 'english' } })
  spoken[0]!.onstart!({} as SpeechSynthesisEvent)
  expect(started).toHaveBeenCalledOnce()
  spoken[0]!.onend!({} as SpeechSynthesisEvent)
  await done
  expect(vi.getTimerCount()).toBe(0)
})

it('stops before queuing the remaining long message', async () => {
  const { playback, spoken, synthesis } = fixture()
  const done = playback.play('Hello. '.repeat(200), { language: 'en-US' }, () => {})
  const rejection = expect(done).rejects.toThrow('SPEECH_CANCELLED')
  playback.stop()
  await rejection
  expect(spoken).toHaveLength(1)
  expect(synthesis.cancel).toHaveBeenCalledOnce()
})

it('reports missing voices and a synthesis engine that never starts', async () => {
  await expect(fixture([]).playback.play('Hello', { language: 'en-US' }, () => {})).rejects.toThrow('SPEECH_SYSTEM_UNAVAILABLE')
  vi.useFakeTimers()
  const { playback } = fixture()
  const rejection = expect(playback.play('Hello', { language: 'en-US' }, () => {})).rejects.toThrow('SPEECH_PLAYBACK_FAILED')
  await vi.advanceTimersByTimeAsync(10000)
  await rejection
})

it('reads prose instead of fenced code, image links and markdown syntax', () => {
  expect(speechText('# Hello\n\n**World** [guide](https://example.test)\n\n```ts\nsecretCode()\n```\n![picture](image.png)')).toBe('Hello\n\nWorld guide')
})
