import { z } from 'zod'

export const workbenchRegions = {
  'window': { title: { 'zh-CN': '整个窗口', 'en-US': 'Window' }, scope: 'application', description: 'The full client window on every page, including settings, the title bar and sidebars. Noninteractive decorations require windowEffects permission.' },
  'app.sidebar': { title: { 'zh-CN': '应用侧栏', 'en-US': 'Application sidebar' }, scope: 'application', description: 'The application sidebar, unavailable while collapsed.' },
  'workbench.sidebar': { title: { 'zh-CN': '任务侧栏', 'en-US': 'Task sidebar' }, scope: 'page', description: 'The task sidebar, unavailable while collapsed or on another page.' },
  'workbench.workspace': { title: { 'zh-CN': '任务主工作区', 'en-US': 'Task workspace' }, scope: 'page', description: 'The task page main workspace across all panes, excluding the title bar, application sidebar, task sidebar and context panel. Hidden on settings and other pages.' },
  'workbench.pane': { title: { 'zh-CN': '分屏区域', 'en-US': 'Pane' }, scope: 'pane', description: 'One independent region per pane, clipped to its bounds. Receives filtered activity from its own composer.' },
  'task.history': { title: { 'zh-CN': '对话历史区', 'en-US': 'Conversation history' }, scope: 'pane', description: 'One visible conversation transcript viewport, excluding its header and composer. Remains fixed while messages scroll; no text or task identity is shared.' },
  'composer.input': { title: { 'zh-CN': '输入框', 'en-US': 'Composer input' }, scope: 'composer', description: 'One composer input. Receives filtered input activity and local caret geometry, never text or keys.' },
} as const

export const workbenchRegionSchema = z.enum(Object.keys(workbenchRegions) as [keyof typeof workbenchRegions, ...(keyof typeof workbenchRegions)[]])
export type WorkbenchRegion = keyof typeof workbenchRegions
