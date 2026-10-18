import { formatLocalChatPublicError } from '@buddy-shared/runtime/localChatError'

import { describe, expect, it } from 'vitest'
import { translateBuddy } from '@/i18n/buddyI18n'
import { resolveLocalChatErrorMessage } from '../localChatError'

describe('desktopChatError', () => {
  it.each([
    ['MUTATION_RESOURCE_UNSAFE', 'desktop.error.resourceRecoveryRequired'],
  ] as const)('shows a localized scoped failure for %s instead of internal recovery details', (code, key) => {
    const error = new Error(`${formatLocalChatPublicError({ code, retryable: false })}:private-recovery-details`)
    for (const language of ['zh-CN', 'en-US'] as const) {
      const message = resolveLocalChatErrorMessage(error, language)
      expect(message).toBe(translateBuddy(language, key))
      expect(message).not.toContain(code)
      expect(message).not.toContain('private-recovery-details')
    }
  })

  it.each(['zh-CN', 'en-US'] as const)('maps an Electron error to %s without exposing provider diagnostics', (language) => {
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
