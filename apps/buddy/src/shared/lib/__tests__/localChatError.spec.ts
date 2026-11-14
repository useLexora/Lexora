import { formatLocalChatPublicError } from '@buddy-shared/runtime/localChatError'

import { describe, expect, it } from 'vitest'
import { translateBuddy } from '@/i18n/buddyI18n'
import { resolveLocalChatErrorMessage } from '../localChatError'

describe('desktopChatError', () => {
  it('maps an Electron error without exposing provider diagnostics', () => {
    const language = 'zh-CN'
    const secret = 'private-provider-diagnostic'
    const error = new Error(`Error invoking remote method 'lexora:buddy:providers:login': Error: ${formatLocalChatPublicError({
      code: 'AUTHENTICATION_REQUIRED',
      retryable: true,
    })}:${secret}`)

    const message = resolveLocalChatErrorMessage(error, language)

    expect(message).toBe(translateBuddy(language, 'desktop.error.authenticationRequired'))
    expect(message).not.toContain(secret)
  })
})
