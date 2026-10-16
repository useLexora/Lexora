import type { UserDeleteSectionProps } from '../typing'

export function normalizeAccountConfirmation(
  value: string,
  mode: UserDeleteSectionProps['confirmationMode'],
) {
  return mode === 'email' ? value.trim().toLowerCase() : value.trim()
}
