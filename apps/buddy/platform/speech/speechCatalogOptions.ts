import type { SpeechChoice } from '../../shared/speech/speechApi'

const choices = (ids: readonly string[]): SpeechChoice[] => ids.map(id => ({ id, name: id }))

export function speechVoices(baseUrl: string, modelId: string): SpeechChoice[] {
  const host = new URL(baseUrl).hostname
  if (host === 'api.openai.com')
    return choices(['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', ...(modelId === 'gpt-4o-mini-tts' ? ['ballad', 'verse', 'marin', 'cedar'] : [])])
  if (host === 'api.siliconflow.cn' && modelId === 'FunAudioLLM/CosyVoice2-0.5B')
    return ['alex', 'benjamin', 'charles', 'david', 'anna', 'bella', 'claire', 'diana'].map(name => ({ id: `${modelId}:${name}`, name }))
  return []
}
