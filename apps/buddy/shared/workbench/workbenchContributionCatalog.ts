import { z } from 'zod'

interface TargetDefinition {
  title: { 'zh-CN': string, 'en-US': string }
  scope: 'application' | 'page' | 'pane' | 'composer' | 'resource' | 'message'
  description: string
}
interface ContentDefinition extends TargetDefinition {
  selection: 'single' | 'multiple'
  height: { min: number, max: number, default: number }
}

export const workbenchSlots = {
  'composer.footer': { title: { 'zh-CN': '输入区下方', 'en-US': 'Below the composer' }, scope: 'composer', selection: 'single', height: { min: 20, max: 48, default: 28 }, description: 'Replace the short footer below each composer. The built-in reminder returns when unavailable.' },
  'composer.accessory': { title: { 'zh-CN': '输入辅助区', 'en-US': 'Composer accessories' }, scope: 'composer', selection: 'multiple', height: { min: 32, max: 240, default: 64 }, description: 'Add independent panels above each composer. Selected providers appear in user order; no draft content is shared.' },
  'task.welcome': { title: { 'zh-CN': '新任务欢迎区', 'en-US': 'New task welcome' }, scope: 'pane', selection: 'single', height: { min: 64, max: 400, default: 240 }, description: 'Replace the welcome artwork and greeting while a task has no messages. The composer remains host-owned.' },
  'workbench.pane.empty': { title: { 'zh-CN': '空白分屏', 'en-US': 'Empty pane' }, scope: 'pane', selection: 'single', height: { min: 64, max: 640, default: 240 }, description: 'Replace the empty surface of a pane without a view. Unavailable providers restore the built-in launcher.' },
} as const satisfies Record<string, ContentDefinition>

export const workbenchControls = {
  'model.reasoning': { title: { 'zh-CN': '思考等级控件', 'en-US': 'Reasoning control' }, scope: 'composer', selection: 'single', height: { min: 32, max: 160, default: 64 }, description: 'Replace the reasoning selector using host-owned options and revision-checked proposals. Requires controls permission.' },
} as const satisfies Record<string, ContentDefinition>

export const workbenchMounts = {
  'workbench': { title: { 'zh-CN': '工作台', 'en-US': 'Workbench' }, scope: 'application', description: 'Persistent mount across pages. Supports static or absolute presentation and placements.show/hide.' },
  'app.sidebar': { title: { 'zh-CN': '应用侧栏', 'en-US': 'Application sidebar' }, scope: 'application', description: 'Mount within the application sidebar.' },
  'workbench.sidebar': { title: { 'zh-CN': '任务侧栏', 'en-US': 'Task sidebar' }, scope: 'page', description: 'Mount within the task sidebar; the view is parked while the sidebar is unavailable.' },
  'workbench.pane': { title: { 'zh-CN': '分屏区域', 'en-US': 'Pane' }, scope: 'pane', description: 'Mount in a specific pane. Pass the originating instanceId to placements.show/hide; omission selects the active pane. Each pane has independent view state.' },
} as const satisfies Record<string, TargetDefinition>

export const workbenchMenus = {
  'composer.actions': { title: { 'zh-CN': '输入操作', 'en-US': 'Composer actions' }, scope: 'composer', description: 'Commands next to composer tools. A click may share draft text with selectedContent permission. Returning {insertText:string} inserts plain text only if the captured draft is unchanged; it never sends.' },
  'task.actions': { title: { 'zh-CN': '任务操作', 'en-US': 'Task actions' }, scope: 'pane', description: 'Commands in the task header. Receives the originating pane instanceId, without task identity or history.' },
  'resource.actions': { title: { 'zh-CN': '文件操作', 'en-US': 'File actions' }, scope: 'resource', description: 'Commands for the selected file. selectedResource:read grants an opaque handle through existing directory authorization.' },
  'message.actions': { title: { 'zh-CN': '消息操作', 'en-US': 'Message actions' }, scope: 'message', description: 'Commands on a completed message. A click may share that message text with selectedContent permission; no conversation history is shared.' },
} as const satisfies Record<string, TargetDefinition>

export const workbenchDecorations = {
  'app.sidebar': { title: { 'zh-CN': '应用侧栏装饰', 'en-US': 'Application sidebar decoration' }, scope: 'application', description: 'Noninteractive decoration; windowEffects permission required.' },
  'workbench.sidebar': { title: { 'zh-CN': '任务侧栏装饰', 'en-US': 'Task sidebar decoration' }, scope: 'page', description: 'Noninteractive task-sidebar decoration.' },
  'workbench.pane': { title: { 'zh-CN': '分屏装饰', 'en-US': 'Pane decoration' }, scope: 'pane', description: 'Independent noninteractive decoration per pane; receives local geometry and filtered input activity.' },
  'composer.input': { title: { 'zh-CN': '输入框装饰', 'en-US': 'Composer decoration' }, scope: 'composer', description: 'Noninteractive decoration per input; activity includes caret geometry, never text or keys.' },
} as const satisfies Record<string, TargetDefinition>

export const workbenchRuntimeCapabilities = {
  'commands': { title: { 'zh-CN': '注册输入命令', 'en-US': 'Registered commands' }, scope: 'application', description: 'API 3 commands may declare slash:{name,description?}. Host exposes /plugin-name:name only (plugin-name is the part after the publisher in the plugin ID); top-level names are system-owned. Local names match [a-z][a-z0-9-]* (max 64). Titles and descriptions may be localized. Duplicate local names or invalid/missing handler registrations fail validation or activation. Another active plugin using the same plugin namespace prevents activation. Slash executes exact names with string arguments and origin pane; no model request. See commands.md.' },
  'workbench.panes': { title: { 'zh-CN': '分屏布局订阅', 'en-US': 'Pane snapshots' }, scope: 'application', description: 'API 3 host workbench.panes and onPanesChange expose opaque id, active, visible, and rect relative to the workbench mount. Subscribe to layout and visibility changes; no task identity, history, or DOM access. See interactions.md.' },
  'workbench.interactions': { title: { 'zh-CN': '临时交互', 'en-US': 'Transient interactions' }, scope: 'application', description: 'API 3 interactions.start(title) returns id, AbortSignal, end(). Mount placements on workbench/workbench.pane declare interaction:regions or exclusive and require {interactionId,instanceId?}. Host exit and Escape revoke views without waiting for plugin cleanup. Regions mode only receives declared hit regions via view.interaction; other pixels pass through. Sessions never restore after restart. See interactions.md.' },
} as const satisfies Record<string, TargetDefinition>

function keys<T extends Record<string, unknown>>(entries: T): [keyof T & string, ...(keyof T & string)[]] {
  return Object.keys(entries) as [keyof T & string, ...(keyof T & string)[]]
}
export const workbenchSlotSchema = z.enum(keys(workbenchSlots))
export const workbenchControlSchema = z.enum(keys(workbenchControls))
export const workbenchMountTargetSchema = z.enum(keys(workbenchMounts))
export const workbenchMenuSchema = z.enum(keys(workbenchMenus))
export const workbenchAnchorSchema = z.enum(keys(workbenchDecorations))
export type WorkbenchSlot = keyof typeof workbenchSlots
export type WorkbenchControl = keyof typeof workbenchControls
export type WorkbenchMountTarget = keyof typeof workbenchMounts
export type WorkbenchMenu = keyof typeof workbenchMenus
export type WorkbenchAnchor = keyof typeof workbenchDecorations

function catalog<K extends string, T extends Record<string, TargetDefinition>>(kind: K, targets: T) {
  return keys(targets).map(target => ({ kind, target, ...targets[target] }))
}
export const workbenchUiTargetCatalog = [...catalog('control', workbenchControls), ...catalog('slot', workbenchSlots)]
export type WorkbenchUiSelectionTarget = Pick<(typeof workbenchUiTargetCatalog)[number], 'kind' | 'target'>
export const workbenchContributionCatalog = [...workbenchUiTargetCatalog, ...catalog('mount', workbenchMounts), ...catalog('menu', workbenchMenus), ...catalog('decoration', workbenchDecorations), ...catalog('runtime', workbenchRuntimeCapabilities)]
export const workbenchCapabilityKinds = ['slot', 'control', 'mount', 'menu', 'decoration', 'runtime'] as const
export const workbenchCapabilityQuerySchema = z.object({ kind: z.enum(workbenchCapabilityKinds).optional(), target: z.string().min(1).max(100).optional() }).strict()
export function queryWorkbenchCapabilities(query: z.infer<typeof workbenchCapabilityQuerySchema>) {
  return workbenchContributionCatalog.filter(entry => (!query.kind || entry.kind === query.kind) && (!query.target || entry.target === query.target))
}
export function workbenchUiSelectionKey(selection: WorkbenchUiSelectionTarget): string {
  return `workbench.${selection.kind === 'control' ? 'controls' : 'slots'}.${selection.target}`
}
export function parseWorkbenchUiSelection(value: unknown, multiple: boolean): string[] | null {
  if (typeof value !== 'string')
    return null
  if (!value)
    return []
  if (!multiple)
    return value.length <= 180 ? [value] : null
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.length <= 8 && parsed.every(id => typeof id === 'string' && id.length > 0 && id.length <= 180) && new Set(parsed).size === parsed.length ? parsed : null
  }
  catch {
    return null
  }
}
export function workbenchMountKey(target: WorkbenchMountTarget, instanceId?: string | null): string {
  return workbenchMounts[target].scope === 'pane' ? `${target}:${instanceId ?? ''}` : target
}
