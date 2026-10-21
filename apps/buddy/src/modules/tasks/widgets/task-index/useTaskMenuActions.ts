import type { LocalTaskMark, LocalTaskMarkState } from '@buddy-shared/conversation/taskMarkApi'
import type { DropdownOption } from 'naive-ui'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Copy20Regular, Settings20Regular, Tag20Regular, TagDismiss20Regular } from '@vicons/fluent'
import { useMessage } from 'naive-ui'
import { computed, h } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { formatSessionReferenceClipboard } from '@/modules/tasks/model/sessionReferenceClipboard'
import { ConversationExportSizeError } from '@/modules/tasks/model/transcript/conversationMarkdown'
import { useTaskEnvironment } from '@/modules/tasks/taskContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopTaskMarkOption from './DesktopTaskMarkOption.vue'
import DesktopTaskMarkSwatch from './DesktopTaskMarkSwatch.vue'

interface TaskMenuSource {
  taskId: string | null
  title: string
  marks: readonly LocalTaskMark[]
  markState?: LocalTaskMarkState
  marksBusy: boolean
}

export function useTaskMenuActions(options: {
  task: () => TaskMenuSource
  language: () => BuddyLocale
  assignMark: (taskId: string, markId: string) => void
  clearMarks: (taskId: string) => void
  setRead: (taskId: string, read: boolean) => void
  manageMarks?: () => void
}) {
  const { t } = useBuddyI18n(options.language)
  const { clipboard, conversationExport } = useTaskEnvironment()
  const notification = useMessage()
  const actions = computed<DropdownOption[]>(() => {
    const task = options.task()
    if (!task.taskId)
      return []
    const markOptions: DropdownOption[] = [
      {
        key: 'read',
        icon: () => h(DesktopTaskMarkSwatch, { color: 'var(--buddy-accent-solid)' }),
        label: () => h(DesktopTaskMarkOption, { name: t('desktop.marks.unread'), selected: task.markState?.unread === true }),
        disabled: task.marksBusy || !task.markState,
      },
      ...task.marks.map(mark => ({
        key: `mark:${mark.id}`,
        label: () => h(DesktopTaskMarkOption, { name: mark.name, selected: task.markState?.markId === mark.id }),
        icon: () => h(DesktopTaskMarkSwatch, { color: mark.color }),
        disabled: task.marksBusy || !task.markState,
      })),
      { type: 'divider', key: 'mark-divider' },
      { key: 'clear-marks', icon: () => h(DesktopIcon, { component: TagDismiss20Regular }), label: t('desktop.marks.none'), disabled: task.marksBusy || !(task.markState?.markId || task.markState?.unread) },
    ]
    if (options.manageMarks)
      markOptions.push({ key: 'manage-marks', icon: () => h(DesktopIcon, { component: Settings20Regular }), label: t('desktop.marks.manage') })
    return [
      { key: 'marks', icon: () => h(DesktopIcon, { component: Tag20Regular }), label: t('desktop.marks.select'), children: markOptions },
      { type: 'divider', key: 'task-actions-divider' },
      {
        key: 'copy',
        icon: () => h(DesktopIcon, { component: Copy20Regular }),
        label: t('desktop.tasks.copy'),
        children: [
          { key: 'copy-task-reference', label: t('desktop.tasks.taskReference') },
          { type: 'divider', key: 'copy-reference-divider' },
          { key: 'copy-task-id', label: t('desktop.tasks.taskId') },
          { key: 'copy-title', label: t('desktop.tasks.title') },
          { key: 'copy-markdown', label: t('desktop.tasks.copyMarkdown'), disabled: conversationExport.busy.value },
        ],
      },
    ]
  })

  async function copyMarkdown(taskId: string, title: string) {
    if (conversationExport.busy.value)
      return
    const loading = notification.loading(t('desktop.tasks.copyMarkdownLoading'), { duration: 0 })
    try {
      const result = await conversationExport.copy(taskId, title, options.language())
      if (result)
        notification.success(t('desktop.tasks.copyMarkdownSuccess', { title: result.title }))
    }
    catch (error) {
      notification.error(t(error instanceof ConversationExportSizeError ? 'desktop.tasks.copyMarkdownTooLarge' : 'desktop.tasks.copyMarkdownFailed'))
    }
    finally {
      loading.destroy()
    }
  }

  function select(action: string | number) {
    const task = options.task()
    if (!task.taskId)
      return
    if (action === 'copy-markdown') {
      void copyMarkdown(task.taskId, task.title)
      return
    }
    if (action === 'read')
      options.setRead(task.taskId, task.markState?.unread === true)
    if (action === 'clear-marks')
      options.clearMarks(task.taskId)
    if (action === 'manage-marks')
      options.manageMarks?.()
    if (typeof action === 'string' && action.startsWith('mark:'))
      options.assignMark(task.taskId, action.slice(5))
    const copyText = action === 'copy-task-reference'
      ? formatSessionReferenceClipboard({ id: task.taskId, title: task.title.slice(0, 80) })
      : action === 'copy-task-id' ? task.taskId : action === 'copy-title' ? task.title : null
    if (copyText !== null) {
      void clipboard.writeText(copyText)
        .catch(() => notification.error(t('desktop.chat.copyFailed')))
    }
  }

  return { actions, select }
}
