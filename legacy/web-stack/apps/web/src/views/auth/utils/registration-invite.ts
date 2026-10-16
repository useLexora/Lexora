import { getSessionStorage, STORAGE_KEY } from '@/utils/storage'

interface StoredRegistrationInviteGrant {
  email: string
  token: string
}

export function savePasswordRegistrationInviteGrant(input: StoredRegistrationInviteGrant): void {
  getSessionStorage().setItem(STORAGE_KEY.registrationInviteGrant, JSON.stringify(input))
}

export function consumePasswordRegistrationInviteGrant(email: string): string | undefined {
  const rawValue = getSessionStorage().getItem(STORAGE_KEY.registrationInviteGrant)
  const grant = rawValue ? parseStoredRegistrationInviteGrant(rawValue) : null

  if (!grant || grant.email !== email) {
    return undefined
  }

  return grant.token
}

export function clearPasswordRegistrationInviteGrant(): void {
  getSessionStorage().removeItem(STORAGE_KEY.registrationInviteGrant)
}

function parseStoredRegistrationInviteGrant(value: string): StoredRegistrationInviteGrant | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredRegistrationInviteGrant>

    if (typeof parsed.email === 'string' && typeof parsed.token === 'string') {
      return {
        email: parsed.email,
        token: parsed.token,
      }
    }
  }
  catch {
  }

  return null
}
