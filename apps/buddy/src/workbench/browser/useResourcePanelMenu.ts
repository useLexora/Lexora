import type { DropdownOption } from 'naive-ui'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

interface MenuTab { id: string, pinned?: boolean }
type CloseAction = 'closeOthers' | 'closeLeft' | 'closeRight' | 'closeAll'
const closeActions: CloseAction[] = ['closeOthers', 'closeLeft', 'closeRight', 'closeAll']

export function useResourcePanelMenu(options: {
  tabs: () => readonly MenuTab[]
  language: () => BuddyLocale
  close: (id: string) => void
  closeMany: (ids: readonly string[]) => void
  pin: (id: string, pinned: boolean) => void
}) {
  const { t } = useBuddyI18n(options.language)
  const targetId = shallowRef<string | null>(null)
  let anchor: HTMLElement | null = null
  const position = shallowRef({ x: 0, y: 0 })
  const target = computed(() => options.tabs().find(tab => tab.id === targetId.value))
  const show = computed(() => !!target.value)
  function targets(action: CloseAction) {
    const tabs = options.tabs()
    const index = tabs.findIndex(tab => tab.id === targetId.value)
    if (index < 0)
      return []
    return tabs.filter((tab, i) => !tab.pinned && (action === 'closeAll'
      || (action === 'closeOthers' && i !== index)
      || (action === 'closeLeft' && i < index)
      || (action === 'closeRight' && i > index))).map(tab => tab.id)
  }
  const entries = computed<DropdownOption[]>(() => [
    { key: 'pin', label: t(target.value?.pinned ? 'desktop.context.unpin' : 'desktop.context.pin') },
    { key: 'divider', type: 'divider' },
    { key: 'close', label: t('desktop.context.close') },
    ...closeActions.map(action => ({ key: action, label: t(`desktop.context.${action}`), disabled: !targets(action).length })),
  ])
  function dismiss() {
    anchor = null
    targetId.value = null
  }
  function clickOutside(event: MouseEvent) {
    if (event.button === 2 && event.target instanceof Node && anchor?.contains(event.target))
      return
    dismiss()
  }
  function open(id: string, event: MouseEvent | KeyboardEvent) {
    event.preventDefault()
    anchor = event.currentTarget as HTMLElement
    if (event instanceof KeyboardEvent) {
      const rect = anchor.getBoundingClientRect()
      position.value = { x: rect.left, y: rect.bottom }
    }
    else {
      position.value = { x: event.clientX, y: event.clientY }
    }
    targetId.value = id
  }
  function select(action: string) {
    const tab = target.value
    if (!tab)
      return
    const ids = closeActions.includes(action as CloseAction) ? targets(action as CloseAction) : []
    dismiss()
    if (action === 'pin')
      options.pin(tab.id, !tab.pinned)
    else if (action === 'close')
      options.close(tab.id)
    else if (ids.length)
      options.closeMany(ids)
  }
  watch(() => options.tabs().map(tab => tab.id).join('\n'), dismiss)
  return { show, position, entries, open, dismiss, clickOutside, select }
}
