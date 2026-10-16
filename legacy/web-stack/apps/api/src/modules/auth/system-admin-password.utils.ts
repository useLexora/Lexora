import { randomBytes } from 'node:crypto'
import { AUTH_PASSWORD_MAX_LENGTH } from '@haohaoxue/lexora-contracts'

const SYSTEM_ADMIN_INITIAL_PASSWORD_PREFIX = 'Aa1'

export function generateSystemAdminInitialPassword(): string {
  return `${SYSTEM_ADMIN_INITIAL_PASSWORD_PREFIX}${randomBytes(AUTH_PASSWORD_MAX_LENGTH).toString('base64url').slice(0, AUTH_PASSWORD_MAX_LENGTH - SYSTEM_ADMIN_INITIAL_PASSWORD_PREFIX.length)}`
}
