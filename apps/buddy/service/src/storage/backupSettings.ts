import { parse, stringify } from 'smol-toml'
import { notificationSoundPreferencesSchema } from '../../../shared/notifications/notificationSound'

const desktopKeys = ['images', 'speech', 'typography', 'plugin_author', 'chat', 'context_panel_mode', 'context_panel_global', 'context_panel_auto_collapse', 'keybindings', 'task_sidebar_pinned_items', 'task_sidebar', 'profile', 'developer_tools_enabled', 'language', 'notifications_enabled', 'notification_sound', 'update_notifications_enabled', 'auto_download_updates', 'notify_when_focused', 'sidebar_collapsed', 'navigation_layout', 'theme', 'accent_color']
const record = (value: unknown): ReturnType<typeof parse> => value && typeof value === 'object' && !Array.isArray(value) ? value as ReturnType<typeof parse> : {}
export function portableSettings(text: string): string {
  const source = parse(text)
  const desktop = record(source.desktop)
  const profile = record(desktop.profile)
  return stringify({
    ...Object.fromEntries(['runtime', 'browser', 'proxy', 'downloads', 'pet'].filter(key => source[key] !== undefined).map(key => [key, source[key]])),
    desktop: { ...Object.fromEntries(desktopKeys.filter(key => desktop[key] !== undefined).map(key => [key, desktop[key]])), profile: { ...(profile.user_name !== undefined ? { user_name: profile.user_name } : {}), ...(profile.avatar !== undefined ? { avatar: profile.avatar } : {}) } },
  } as ReturnType<typeof parse>)
}

export function notificationSoundSettings(text: string) {
  const value = record(parse(text).desktop).notification_sound
  return value === undefined ? null : notificationSoundPreferencesSchema.parse(value)
}

export function mergeSettings(current: string, incoming: string): string {
  const merge = (left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> => ({ ...left, ...Object.fromEntries(Object.entries(right).map(([key, value]) => [key, value && typeof value === 'object' && !Array.isArray(value) ? merge(record(left[key]), record(value)) : value])) })
  const existing = parse(current)
  const portable = parse(portableSettings(incoming))
  const result = merge(existing, portable)
  const incomingImages = record(portable.desktop).images
  if (incomingImages !== undefined)
    record(result.desktop).images = { ...record(record(existing.desktop).images), ...record(incomingImages) }
  const imported = notificationSoundSettings(incoming)
  if (imported) {
    const sounds = new Map(notificationSoundSettings(current)?.sounds.map(sound => [sound.id, sound]))
    for (const sound of imported.sounds)
      sounds.set(sound.id, sound)
    result.desktop = {
      ...record(result.desktop),
      notification_sound: notificationSoundPreferencesSchema.parse({ ...imported, sounds: [...sounds.values()] }),
    }
  }
  return stringify(result as ReturnType<typeof parse>)
}
