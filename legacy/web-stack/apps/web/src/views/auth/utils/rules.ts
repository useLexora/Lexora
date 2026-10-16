import type { FormItemRule } from 'element-plus'
import {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
  AUTH_PASSWORD_REQUIRED_PATTERN,
} from '@haohaoxue/lexora-contracts/identity/constants'
import { translate } from '@/i18n'

const EMAIL_RE = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/
const DISPLAY_NAME_MIN_LENGTH = 2
const DISPLAY_NAME_MAX_LENGTH = 50

type RuleValidator = NonNullable<FormItemRule['validator']>
type RequiredMessageResolver = (label: string) => string
type LengthMessageResolver = (label: string, min: number, max: number) => string
type MismatchMessageResolver = () => string

export interface AuthRuleMessages {
  confirmPasswordMismatch?: MismatchMessageResolver
  differentPassword?: MismatchMessageResolver
  displayNameLength?: LengthMessageResolver
  emailInvalid?: RequiredMessageResolver
  passwordInvalid?: LengthMessageResolver
  required?: RequiredMessageResolver
}

type Translate = (key: string, params?: Record<string, unknown>) => string

export function createAuthRuleMessages(t: Translate): AuthRuleMessages {
  return {
    confirmPasswordMismatch: () => t('auth.validation.confirmPasswordMismatch'),
    differentPassword: () => t('auth.validation.differentPassword'),
    displayNameLength: (field, min, max) => t('auth.validation.displayNameLength', { field, min, max }),
    emailInvalid: field => t('auth.validation.emailInvalid', { field }),
    passwordInvalid: (field, min, max) => t('auth.validation.passwordRule', { field, min, max }),
    required: field => t('auth.validation.required', { field }),
  }
}

function resolveTrimmedValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function createRequiredMessage(label: string, messages?: AuthRuleMessages) {
  return messages?.required?.(label) ?? translate('auth.validation.required', { field: label })
}

export function isValidEmail(value: string) {
  const normalizedValue = resolveTrimmedValue(value)
  return Boolean(normalizedValue) && EMAIL_RE.test(normalizedValue)
}

export function isValidPassword(value: string) {
  return value.length >= AUTH_PASSWORD_MIN_LENGTH
    && value.length <= AUTH_PASSWORD_MAX_LENGTH
    && AUTH_PASSWORD_REQUIRED_PATTERN.test(value)
}

export function isValidDisplayName(value: string) {
  const normalizedValue = resolveTrimmedValue(value)
  return normalizedValue.length >= DISPLAY_NAME_MIN_LENGTH && normalizedValue.length <= DISPLAY_NAME_MAX_LENGTH
}

function createDisplayNameValidator(label: string, messages?: AuthRuleMessages): RuleValidator {
  return (_rule, value, callback) => {
    const normalizedValue = resolveTrimmedValue(value)

    if (!normalizedValue) {
      callback(new Error(createRequiredMessage(label, messages)))
      return
    }

    if (normalizedValue.length < DISPLAY_NAME_MIN_LENGTH || normalizedValue.length > DISPLAY_NAME_MAX_LENGTH) {
      callback(new Error(messages?.displayNameLength?.(label, DISPLAY_NAME_MIN_LENGTH, DISPLAY_NAME_MAX_LENGTH)
        ?? translate('auth.validation.displayNameLength', { field: label, min: DISPLAY_NAME_MIN_LENGTH, max: DISPLAY_NAME_MAX_LENGTH })))
      return
    }

    callback()
  }
}

function createPasswordValidator(label: string, messages?: AuthRuleMessages): RuleValidator {
  return (_rule, value, callback) => {
    if (typeof value !== 'string' || !value.length) {
      callback()
      return
    }

    if (!isValidPassword(value)) {
      callback(new Error(messages?.passwordInvalid?.(label, AUTH_PASSWORD_MIN_LENGTH, AUTH_PASSWORD_MAX_LENGTH)
        ?? translate('auth.validation.passwordRule', { field: label, min: AUTH_PASSWORD_MIN_LENGTH, max: AUTH_PASSWORD_MAX_LENGTH })))
      return
    }

    callback()
  }
}

export function createEmailRules(label = translate('auth.common.email'), messages?: AuthRuleMessages): FormItemRule[] {
  return [
    {
      required: true,
      message: createRequiredMessage(label, messages),
      transform: resolveTrimmedValue,
    },
    {
      pattern: EMAIL_RE,
      message: messages?.emailInvalid?.(label) ?? translate('auth.validation.emailInvalid', { field: label }),
      transform: resolveTrimmedValue,
    },
  ]
}

export function createPasswordRules(label = translate('auth.common.password'), messages?: AuthRuleMessages): FormItemRule[] {
  return [
    {
      required: true,
      message: createRequiredMessage(label, messages),
    },
    {
      validator: createPasswordValidator(label, messages),
    },
  ]
}

export function createDisplayNameRules(label = translate('auth.common.displayName'), messages?: AuthRuleMessages): FormItemRule[] {
  return [{
    required: true,
    validator: createDisplayNameValidator(label, messages),
  }]
}

export function createConfirmPasswordRules(
  getSourcePassword: () => string,
  label = translate('auth.common.confirmPassword'),
  mismatchMessage = translate('auth.validation.confirmPasswordMismatch'),
  messages?: AuthRuleMessages,
): FormItemRule[] {
  return [
    {
      required: true,
      message: createRequiredMessage(label, messages),
    },
    {
      validator: (_rule, value, callback) => {
        if (typeof value !== 'string' || !value.length || value === getSourcePassword()) {
          callback()
          return
        }

        callback(new Error(messages?.confirmPasswordMismatch?.() ?? mismatchMessage))
      },
    },
  ]
}

export function createDifferentPasswordRule(
  getCurrentPassword: () => string,
  message = translate('auth.validation.differentPassword'),
  messages?: AuthRuleMessages,
): FormItemRule {
  return {
    validator: (_rule, value, callback) => {
      if (typeof value !== 'string' || !value.length) {
        callback()
        return
      }

      if (value === getCurrentPassword()) {
        callback(new Error(messages?.differentPassword?.() ?? message))
        return
      }

      callback()
    },
  }
}
