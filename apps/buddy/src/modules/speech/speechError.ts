export function speechErrorKey(error: string, fallback: 'speech.failed' | 'speech.playbackFailed' | 'speech.voicesLoadFailed') {
  if (error === 'permission' || /NotAllowedError|NotFoundError|DEVICE_LOST/.test(error))
    return 'speech.permission'
  if (error.includes('SPEECH_SYSTEM_UNAVAILABLE'))
    return 'speech.systemUnavailable'
  if (error.includes('SPEECH_VOICE_REQUIRED'))
    return 'speech.voiceRequired'
  if (error.includes('SPEECH_TEXT_EMPTY'))
    return 'speech.textEmpty'
  if (error.includes('SPEECH_PROVIDER_UNAVAILABLE'))
    return 'speech.unavailable'
  if (error.includes('SPEECH_NOT_CONFIGURED'))
    return 'speech.notConfigured'
  if (error.includes('SPEECH_SERVICE_UNAUTHORIZED'))
    return 'speech.serviceUnauthorized'
  if (error.includes('SPEECH_SERVICE_FORBIDDEN'))
    return 'speech.serviceForbidden'
  if (error.includes('SPEECH_SERVICE_QUOTA_EXCEEDED'))
    return 'speech.serviceQuotaExceeded'
  if (error.includes('SPEECH_SERVICE_BUSY'))
    return 'speech.serviceBusy'
  if (error.includes('SPEECH_SERVICE_DISCONNECTED'))
    return 'speech.serviceDisconnected'
  return fallback
}
