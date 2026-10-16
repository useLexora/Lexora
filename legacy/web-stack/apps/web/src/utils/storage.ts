export const STORAGE_KEY = {
  auth: 'lexora.auth',
  authRedirect: 'lexora.auth_redirect',
  registrationInviteGrant: 'lexora.registration_invite_grant',
  ui: 'lexora.ui',
  user: 'lexora.user',
  workspace: 'lexora.workspace',
  workspaceEntry: 'lexora.workspace_entry',
} as const

export function getLocalStorage() {
  return window.localStorage
}

export function getSessionStorage() {
  return window.sessionStorage
}
