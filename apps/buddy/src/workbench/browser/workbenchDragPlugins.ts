import { AutoScroller, defaultPreset, Feedback } from '@dnd-kit/dom'

function isAutoScrollerPlugin(plugin: unknown): boolean {
  if (plugin === AutoScroller)
    return true
  if (typeof plugin === 'function' && plugin.name.includes('AutoScroller'))
    return true
  if (typeof plugin === 'object' && plugin !== null && 'plugin' in plugin)
    return isAutoScrollerPlugin((plugin as { plugin: unknown }).plugin)
  return false
}

export function createWorkbenchDragPlugins() {
  return defaultPreset.plugins
    .filter(plugin => !isAutoScrollerPlugin(plugin))
    .map(plugin => plugin === Feedback ? Feedback.configure({ dropAnimation: null }) : plugin)
}
