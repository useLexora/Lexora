import type { DesktopAppInfo, DesktopPlatform, DesktopUserProfileConfig } from '@buddy-electron/shared/desktopApi'

export interface ResolvedUserProfile {
  avatarColor: string
  avatarUrl: string | null
  configPath: string
  deviceName: string
  initials: string
  isCustomAvatar: boolean
  isCustomDeviceName: boolean
  isCustomUserName: boolean
  platform: DesktopPlatform
  systemAvatarUrl: string | null
  systemDisplayName: string
  systemHostname: string
  systemUsername: string
  userName: string
}

const AVATAR_PALETTES = [
  '#4a72b0',
  '#3d8b80',
  '#508c58',
  '#a3683b',
  '#b25252',
  '#8c5888',
  '#5c689e',
  '#52798e',
]

export function getDeterministicAvatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i)
    hash |= 0
  }
  const index = Math.abs(hash) % AVATAR_PALETTES.length
  return AVATAR_PALETTES[index]!
}

export function extractInitials(name: string): string {
  const trimmed = name.trim().replace(/^[^a-z0-9\u4E00-\u9FA5]+/i, '')
  if (!trimmed)
    return 'U'

  if (/^[\u4E00-\u9FA5]/.test(trimmed))
    return trimmed.slice(0, 1)

  const parts = trimmed.split(/[\s\-_]+/).filter(Boolean)
  if (parts.length >= 2)
    return (parts[0][0] + parts[1][0]).toUpperCase()

  return trimmed.slice(0, 1).toUpperCase()
}

export function resolveUserProfile(
  profileConfig?: Partial<DesktopUserProfileConfig> | null,
  appInfo?: DesktopAppInfo | null,
): ResolvedUserProfile {
  const systemUsername = appInfo?.systemProfile?.username ?? ''
  const systemDisplayName = appInfo?.systemProfile?.displayName ?? ''
  const systemHostname = appInfo?.systemProfile?.hostname ?? ''
  const systemAvatarUrl = appInfo?.systemProfile?.avatarUrl ?? null

  const isCustomUserName = !!profileConfig?.userName?.trim()
  const isCustomDeviceName = !!profileConfig?.deviceName?.trim()
  const isCustomAvatar = !!profileConfig?.avatar?.trim()

  const userName = profileConfig?.userName?.trim()
    || systemDisplayName.trim()
    || systemUsername.trim()
    || 'User'

  const deviceName = profileConfig?.deviceName?.trim()
    || systemHostname.trim()
    || 'Desktop'

  const avatarUrl = profileConfig?.avatar?.trim()
    || systemAvatarUrl
    || null

  const initials = extractInitials(userName)
  const avatarColor = getDeterministicAvatarColor(userName)

  return {
    avatarColor,
    avatarUrl,
    configPath: appInfo?.configPath ?? '',
    deviceName,
    initials,
    isCustomAvatar,
    isCustomDeviceName,
    isCustomUserName,
    platform: appInfo?.platform ?? 'linux',
    systemAvatarUrl,
    systemDisplayName,
    systemHostname,
    systemUsername,
    userName,
  }
}
