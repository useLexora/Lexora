import { parse, stringify } from 'smol-toml'

const desktopKeys = ['typography', 'plugin_author', 'chat', 'context_panel_mode', 'context_panel_global', 'keybindings', 'task_sidebar_pinned_items', 'task_sidebar', 'profile', 'developer_tools_enabled', 'language', 'notifications_enabled', 'update_notifications_enabled', 'auto_download_updates', 'notify_when_focused', 'sidebar_collapsed', 'theme', 'accent_color']
const record = (value: unknown): ReturnType<typeof parse> => value && typeof value === 'object' && !Array.isArray(value) ? value as ReturnType<typeof parse> : {}
export function portableSettings(text: string): string {
  const source = parse(text)
  const desktop = record(source.desktop)
  const profile = record(desktop.profile)
  return stringify({
    ...Object.fromEntries(['runtime', 'browser', 'proxy', 'pet'].filter(key => source[key] !== undefined).map(key => [key, source[key]])),
    desktop: { ...Object.fromEntries(desktopKeys.filter(key => desktop[key] !== undefined).map(key => [key, desktop[key]])), profile: { ...(profile.user_name !== undefined ? { user_name: profile.user_name } : {}), ...(profile.avatar !== undefined ? { avatar: profile.avatar } : {}) } },
  } as ReturnType<typeof parse>)
}
export function mergeSettings(current: string, incoming: string): string {
  const merge = (left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> => ({ ...left, ...Object.fromEntries(Object.entries(right).map(([key, value]) => [key, value && typeof value === 'object' && !Array.isArray(value) ? merge(record(left[key]), record(value)) : value])) })
  return stringify(merge(parse(current), parse(portableSettings(incoming))) as ReturnType<typeof parse>)
}
