import type { Ref } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, useDialog } from 'naive-ui'
import { h } from 'vue'
import { workbenchLabels } from '@/workbench/common/workbenchLabels'

export function useWorkbenchDialogs(language: Readonly<Ref<BuddyLocale>>) {
  const dialog = useDialog()
  const labels = () => workbenchLabels(language.value)
  function promptUnsentDraftAction(): Promise<'split' | 'discard' | 'cancel'> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (choice: 'split' | 'discard' | 'cancel') => {
        if (!settled) {
          settled = true
          resolve(choice)
        }
      }
      const modal = dialog.warning({
        title: labels().unsentDraftPrompt,
        content: labels().unsentDraftDetail,
        closable: true,
        onClose: () => finish('cancel'),
        onMaskClick: () => finish('cancel'),
        onEsc: () => finish('cancel'),
        action: () => h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;width:100%' }, [
          h(NButton, {
            size: 'small',
            onClick: () => {
              finish('cancel')
              modal.destroy()
            },
          }, () => labels().cancel),
          h(NButton, {
            size: 'small',
            type: 'error',
            onClick: () => {
              finish('discard')
              modal.destroy()
            },
          }, () => labels().discardDraft),
          h(NButton, {
            size: 'small',
            type: 'primary',
            onClick: () => {
              finish('split')
              modal.destroy()
            },
          }, () => labels().splitOpen),
        ]),
      })
    })
  }

  function promptUnsentDraftCloseAction(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (confirmed: boolean) => {
        if (!settled) {
          settled = true
          resolve(confirmed)
        }
      }
      const modal = dialog.warning({
        title: labels().unsentDraftPrompt,
        content: labels().unsentDraftCloseDetail,
        closable: true,
        onClose: () => finish(false),
        onMaskClick: () => finish(false),
        onEsc: () => finish(false),
        action: () => h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;width:100%' }, [
          h(NButton, {
            size: 'small',
            onClick: () => {
              finish(false)
              modal.destroy()
            },
          }, () => labels().cancel),
          h(NButton, {
            size: 'small',
            type: 'error',
            onClick: () => {
              finish(true)
              modal.destroy()
            },
          }, () => labels().discardDraft),
        ]),
      })
    })
  }

  function confirmSaveFiles(paths: readonly string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const chinese = language.value === 'zh-CN'
      dialog.warning({ title: chinese ? '先保存打开的文件' : 'Save open files first', content: `${chinese ? '这些文件有未保存的修改：' : 'These files have unsaved changes:'}\n${[...new Set(paths)].join('\n')}`, positiveText: chinese ? '保存并继续' : 'Save and continue', negativeText: chinese ? '取消' : 'Cancel', onPositiveClick: () => resolve(true), onNegativeClick: () => resolve(false), onClose: () => resolve(false), onMaskClick: () => resolve(false), onEsc: () => resolve(false) })
    })
  }

  function confirmFileClose(title: string, actions: { discard: () => void, save: () => Promise<boolean> }): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const modal = dialog.warning({
        title: labels().savePrompt,
        content: title,
        onClose: () => finish(false),
        onMaskClick: () => finish(false),
        onEsc: () => finish(false),
        action: () => h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;width:100%' }, [
          h(NButton, { size: 'small', onClick: () => finish(false) }, () => labels().cancel),
          h(NButton, { size: 'small', type: 'error', onClick: () => {
            actions.discard()
            finish(true)
          } }, () => labels().discard),
          h(NButton, { size: 'small', type: 'primary', onClick: async () => {
            if (await actions.save())
              finish(true)
          } }, () => labels().save),
        ]),
      })
      function finish(accepted: boolean) {
        if (settled)
          return
        settled = true
        resolve(accepted)
        modal.destroy()
      }
    })
  }

  return { confirmSaveFiles, confirmFileClose, promptUnsentDraftAction, promptUnsentDraftCloseAction }
}
