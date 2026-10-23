import type { SelectionReferenceRequest } from './workbenchSelectionReferences'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, useDialog } from 'naive-ui'
import { h, onScopeDispose } from 'vue'
import { translateBuddy } from '@/i18n/buddyI18n'

export function useReferenceTargetPicker(language: () => BuddyLocale) {
  const dialog = useDialog()
  let pending: (() => void) | undefined
  onScopeDispose(() => pending?.())
  return (request: Omit<SelectionReferenceRequest, 'quote'>, title: string, signal: AbortSignal): Promise<string | null> => {
    if (pending || signal.aborted || !request.targets.length)
      return Promise.resolve(null)
    return new Promise((resolve) => {
      let settled = false
      let modal: ReturnType<typeof dialog.create> | undefined
      const cancel = () => finish(null)
      function finish(id: string | null) {
        if (settled)
          return
        settled = true
        signal.removeEventListener('abort', cancel)
        pending = undefined
        modal?.destroy()
        resolve(id)
      }
      modal = dialog.create({
        title: translateBuddy(language(), 'desktop.chat.quoteChooseTarget'),
        content: title,
        onClose: cancel,
        onEsc: cancel,
        onMaskClick: cancel,
        action: () => h('div', { class: 'flex flex-col gap-2 w-full' }, request.targets.map(target => h(NButton, {
          onClick: () => finish(target.id),
        }, () => target.label))),
      })
      pending = cancel
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted)
        cancel()
    })
  }
}
