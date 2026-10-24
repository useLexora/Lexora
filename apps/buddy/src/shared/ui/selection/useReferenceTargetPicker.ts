import type { SelectionReferenceRequest } from './workbenchSelectionReferences'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useDialog } from 'naive-ui'
import { h, onScopeDispose } from 'vue'
import { translateBuddy } from '@/i18n/buddyI18n'
import ReferenceTargetPicker from './ReferenceTargetPicker.vue'

export type ReferenceTargetOption = SelectionReferenceRequest['targets'][number]
export type ReferenceTargetChoice = { kind: 'view', id: string } | { kind: 'new-task' | 'clipboard' }

export function useReferenceTargetPicker(language: () => BuddyLocale) {
  const dialog = useDialog()
  let pending: (() => void) | undefined
  onScopeDispose(() => pending?.())
  return (request: Omit<SelectionReferenceRequest, 'quote'>, title: string, signal: AbortSignal, allowClipboard: boolean): Promise<ReferenceTargetChoice | null> => {
    if (pending || signal.aborted)
      return Promise.resolve(null)
    return new Promise((resolve) => {
      let settled = false
      let modal: ReturnType<typeof dialog.create> | undefined
      const cancel = () => finish(null)
      function finish(choice: ReferenceTargetChoice | null) {
        if (settled)
          return
        settled = true
        signal.removeEventListener('abort', cancel)
        pending = undefined
        modal?.destroy()
        resolve(choice)
      }
      modal = dialog.create({
        title: translateBuddy(language(), 'desktop.chat.quoteChooseTarget'),
        showIcon: false,
        style: { width: 'min(420px, calc(100vw - 32px))' },
        content: () => h(ReferenceTargetPicker, { language: language(), title, targets: request.targets, allowClipboard, onChoose: finish }),
        onClose: cancel,
        onEsc: cancel,
        onMaskClick: cancel,
      })
      pending = cancel
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted)
        cancel()
    })
  }
}
