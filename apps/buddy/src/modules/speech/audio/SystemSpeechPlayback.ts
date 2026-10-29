export function systemVoices(synthesis: SpeechSynthesis | undefined): SpeechSynthesisVoice[] {
  return synthesis?.getVoices().filter(voice => voice.localService) ?? []
}

export function chooseSystemVoice(voices: SpeechSynthesisVoice[], saved: string | undefined, language: string): SpeechSynthesisVoice | undefined {
  return voices.find(voice => voice.voiceURI === saved)
    ?? voices.find(voice => voice.lang.toLowerCase() === language.toLowerCase())
    ?? voices.find(voice => voice.lang.split('-')[0] === language.split('-')[0])
    ?? voices.find(voice => voice.default)
    ?? voices[0]
}

export class SystemSpeechPlayback {
  #cancelled = false
  #settle?: (error?: Error) => void
  readonly synthesis: SpeechSynthesis
  constructor(synthesis: SpeechSynthesis = window.speechSynthesis) {
    this.synthesis = synthesis
  }

  async play(text: string, options: { voice?: string, rate?: number, language: string }, started: () => void): Promise<void> {
    const voice = chooseSystemVoice(systemVoices(this.synthesis), options.voice, options.language)
    if (!voice)
      throw new Error('SPEECH_SYSTEM_UNAVAILABLE')
    const chunks = text.match(/[\s\S]{1,220}(?:[。！？.!?\s]|$)|[\s\S]{1,220}/gu) ?? []
    for (const chunk of chunks) {
      if (this.#cancelled)
        throw new Error('SPEECH_CANCELLED')
      await new Promise<void>((resolve, reject) => {
        const utterance = new SpeechSynthesisUtterance(chunk)
        utterance.voice = voice
        utterance.lang = voice.lang
        utterance.rate = options.rate ?? 1
        let timer: ReturnType<typeof setTimeout>
        const settle = (error?: Error) => {
          clearTimeout(timer)
          utterance.onstart = utterance.onend = utterance.onerror = null
          if (this.#settle === settle)
            this.#settle = undefined
          error ? reject(error) : resolve()
        }
        this.#settle = settle
        timer = setTimeout(() => {
          settle(new Error('SPEECH_PLAYBACK_FAILED'))
          this.synthesis.cancel()
        }, 10000)
        utterance.onstart = () => {
          clearTimeout(timer)
          timer = setTimeout(() => {
            settle(new Error('SPEECH_PLAYBACK_FAILED'))
            this.synthesis.cancel()
          }, 120000)
          started()
        }
        utterance.onend = () => settle()
        utterance.onerror = event => settle(new Error(event.error === 'canceled' || event.error === 'interrupted' ? 'SPEECH_CANCELLED' : 'SPEECH_PLAYBACK_FAILED'))
        try {
          this.synthesis.speak(utterance)
        }
        catch { settle(new Error('SPEECH_PLAYBACK_FAILED')) }
      })
    }
  }

  stop(): void {
    this.#cancelled = true
    this.#settle?.(new Error('SPEECH_CANCELLED'))
    this.synthesis?.cancel()
  }
}
