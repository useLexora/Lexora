import type { SpeechKind, SpeechProvider } from '../../shared/speech/speechApi'

type SpeechCapabilities = Pick<SpeechProvider, 'supportsRate' | 'supportsVoiceSelection' | 'supportsLanguageSelection'>

export function speechCapabilities(baseUrl: string, kind: SpeechKind): SpeechCapabilities {
  const output = kind === 'speech.synthesize'
  const host = new URL(baseUrl).hostname
  return {
    supportsVoiceSelection: output,
    supportsLanguageSelection: !output && host !== 'api.siliconflow.cn',
    supportsRate: output && host !== 'api.groq.com',
  }
}
