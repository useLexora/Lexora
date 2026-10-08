<script setup lang="ts">
import type { DesktopSelectionEditCommand } from '@buddy-electron/shared/desktopApi'
import type { BuddyResourceQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { DropdownOption } from 'naive-ui'
import type { SelectionReferenceEditSource, SelectionReferenceRequest } from './workbenchSelectionReferences'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { buddyResourceQuoteSchema } from '@buddy-shared/conversation/buddyUserContent'
import { useEventListener } from '@vueuse/core'
import { NDropdown, useMessage } from 'naive-ui'
import { computed, h, nextTick, onBeforeUnmount, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useSelectionReferences } from './workbenchSelectionReferences'

const props = defineProps<{ viewId: string, ownerKey: string, language: BuddyLocale, visible: boolean }>()
const references = useSelectionReferences()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
let mounted = true
const pending = shallowRef<SelectionReferenceRequest | null>(null)
const editing = shallowRef<{ editable: boolean, source: SelectionReferenceEditSource } | null>(null)
const position = shallowRef({ x: 0, y: 0 })
const mac = navigator.platform.includes('Mac')
const shortcuts: Record<DesktopSelectionEditCommand, string> = {
  undo: mac ? '⌘Z' : 'Ctrl+Z',
  redo: mac ? '⇧⌘Z' : 'Ctrl+Y',
  cut: mac ? '⌘X' : 'Ctrl+X',
  copy: mac ? '⌘C' : 'Ctrl+C',
  paste: mac ? '⌘V' : 'Ctrl+V',
  selectAll: mac ? '⌘A' : 'Ctrl+A',
}
const editCommands: Record<string, DesktopSelectionEditCommand> = {
  'edit:undo': 'undo',
  'edit:redo': 'redo',
  'edit:cut': 'cut',
  'edit:copy': 'copy',
  'edit:paste': 'paste',
  'edit:selectAll': 'selectAll',
}
const options = computed<DropdownOption[]>(() => {
  const request = pending.value
  const edit = (command: DesktopSelectionEditCommand): DropdownOption => ({ key: `edit:${command}`, label: t(`desktop.chat.selectionMenu.${command}`) })
  const original: DropdownOption[] = references?.options.editSelection && editing.value
    ? editing.value.editable
      ? [edit('undo'), edit('redo'), { key: 'editing-before-clipboard', type: 'divider' }, edit('cut'), edit('copy'), edit('paste'), { key: 'editing-after-clipboard', type: 'divider' }, edit('selectAll')]
      : [edit('copy')]
    : []
  if (!request?.targets.length)
    return [...original, { key: 'unavailable', label: t('desktop.chat.quoteNoTarget'), disabled: true }]
  const preferred = request.targets.find(target => target.id === request.defaultId)
  const others = request.targets.filter(target => target.id !== preferred?.id)
  const children = others.map(target => ({ key: target.id, label: target.label }))
  return [
    ...original,
    ...(preferred ? [{ key: preferred.id, label: !request.isSplit && request.targets.length === 1 ? t('desktop.chat.quoteToCurrent') : t('desktop.chat.quoteToTarget', { title: preferred.label }) }] : []),
    ...(children.length ? [{ key: 'targets', label: t(preferred ? 'desktop.chat.quoteOtherTarget' : 'desktop.chat.quoteChooseTarget'), children }] : []),
  ]
})
function renderLabel(option: DropdownOption) {
  const label = String(option.label ?? '')
  const command = editCommands[String(option.key)]
  return h('span', { class: 'resource-selection-menu-option' }, [
    h('span', { class: 'resource-selection-menu-option__label' }, label),
    ...(command ? [h('span', { 'class': 'resource-selection-menu-option__shortcut', 'aria-hidden': 'true' }, shortcuts[command])] : []),
  ])
}
function menuProps() {
  return {
    'class': 'buddy-selection-menu resource-selection-menu',
    'role': 'menu',
    'aria-label': t('desktop.chat.quoteChooseTarget'),
    'style': 'width: var(--buddy-menu-width, 12.5rem); max-width: min(var(--buddy-menu-max-width, 17.5rem), calc(100vw - 16px));',
  }
}
function close() {
  pending.value = null
  editing.value = null
}
onBeforeUnmount(() => {
  mounted = false
  close()
})
watch([() => props.ownerKey, () => props.visible], close, { flush: 'sync' })
useEventListener(window, 'resize', close)
useEventListener(window, 'blur', close)
useEventListener(document, 'keydown', (event) => {
  if (event.key === 'Escape' || event.key === 'Tab')
    close()
})
function prepare(quote: BuddyResourceQuote, x: number, y: number, isEditable = false, editSource?: SelectionReferenceEditSource): (() => void) | null {
  if (!mounted || !props.visible || !references)
    return null
  const request = references.capture(props.viewId, quote)
  const ownerKey = props.ownerKey
  const selection = window.getSelection()
  const range = selection?.rangeCount === 1 && selection.toString() === quote.text ? selection.getRangeAt(0).cloneRange() : null
  const source = editSource ?? { restore: () => {
    if (!range || !range.startContainer.isConnected || !range.endContainer.isConnected || range.toString() !== quote.text)
      return false
    const current = window.getSelection()
    current?.removeAllRanges()
    current?.addRange(range)
    return Boolean(current)
  } }
  return () => {
    close()
    if (!mounted || !props.visible || ownerKey !== props.ownerKey) {
      message.warning(t('desktop.chat.quoteTargetChanged'))
      return
    }
    if (!request) {
      message.warning(t(buddyResourceQuoteSchema.safeParse(quote).success ? 'desktop.chat.quoteTargetChanged' : 'desktop.chat.quoteLimit'))
      return
    }
    position.value = { x, y }
    editing.value = { editable: isEditable, source }
    pending.value = request
  }
}
function open(quote: BuddyResourceQuote, x: number, y: number): boolean {
  const show = prepare(quote, x, y)
  show?.()
  return Boolean(show)
}
async function select(targetId: string) {
  const request = pending.value
  const edit = editing.value
  close()
  if (!request || !references || !props.visible)
    return
  const command = editCommands[targetId]
  if (command) {
    await nextTick()
    if (!mounted || !props.visible || !references.isSourceCurrent(request) || !edit?.source.restore()) {
      message.warning(t('desktop.chat.quoteTargetChanged'))
      return
    }
    try {
      if (!edit.source.executeLocal?.(command))
        await references.options.editSelection?.(command)
    }
    catch {
      message.warning(t('desktop.chat.quoteUnavailable'))
    }
    return
  }
  const result = references.add(request, targetId)
  if (result === 'added') {
    message.success(t('desktop.chat.quoteAddedToTarget', { title: request.targets.find(target => target.id === targetId)?.label ?? '' }))
  }
  else if (result === 'duplicate') {
    message.info(t('desktop.chat.quoteDuplicate'))
  }
  else {
    message.warning(t(result === 'limit' ? 'desktop.chat.quoteLimit' : 'desktop.chat.quoteTargetChanged'))
  }
}
function openRequest(request: SelectionReferenceRequest, x: number, y: number) {
  close()
  if (!mounted || !props.visible || !references?.isSourceCurrent(request)) {
    message.warning(t('desktop.chat.quoteTargetChanged'))
    return
  }
  position.value = { x, y }
  pending.value = request
}
defineExpose({ open, prepare, close, openRequest })
</script>

<template>
  <NDropdown
    trigger="manual" placement="bottom-start" :show="pending !== null" :x="position.x" :y="position.y" :options="options"
    size="small" :menu-props="menuProps" :render-label="renderLabel"
    :node-props="option => ({ 'role': 'menuitem', 'aria-label': String(option.label ?? '') })"
    @select="select" @clickoutside="close" @update:show="show => !show && close()"
  />
</template>

<style>
.resource-selection-menu .n-dropdown-option-body__label { min-width: 0; overflow: hidden; }
.resource-selection-menu-option { display: flex; width: 100%; min-width: 0; align-items: center; gap: 1.25rem; }
.resource-selection-menu-option__label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.resource-selection-menu-option__shortcut { flex: none; color: var(--buddy-text-muted); font-size: 0.72rem; }
.resource-selection-menu .n-dropdown-option-body--pending .resource-selection-menu-option__shortcut,
.resource-selection-menu .n-dropdown-option-body--active .resource-selection-menu-option__shortcut { color: var(--buddy-text-on-accent); }
</style>
