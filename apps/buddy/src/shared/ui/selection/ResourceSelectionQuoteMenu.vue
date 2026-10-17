<script setup lang="ts">
import type { BuddyResourceQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { DropdownOption } from 'naive-ui'
import type { MonacoResourceQuoteMenu } from './useMonacoResourceQuote'
import type { SelectionReferenceRequest } from './workbenchSelectionReferences'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { buddyResourceQuoteSchema } from '@buddy-shared/conversation/buddyUserContent'
import { useEventListener } from '@vueuse/core'
import { NDropdown, useMessage } from 'naive-ui'
import { computed, h, onBeforeUnmount, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useSelectionReferences } from './workbenchSelectionReferences'

const props = defineProps<{ viewId: string, ownerKey: string, language: BuddyLocale, visible: boolean }>()
const references = useSelectionReferences()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
let mounted = true
const pending = shallowRef<SelectionReferenceRequest | null>(null)
const position = shallowRef({ x: 0, y: 0 })
const options = computed<DropdownOption[]>(() => {
  const request = pending.value
  if (!request?.targets.length)
    return [{ key: 'unavailable', label: t('desktop.chat.quoteNoTarget'), disabled: true }]
  const preferred = request.targets.find(target => target.id === request.defaultId)
  const others = request.targets.filter(target => target.id !== preferred?.id)
  const children = others.map(target => ({ key: target.id, label: target.label }))
  return [
    ...(preferred ? [{ key: preferred.id, label: !request.isSplit && request.targets.length === 1 ? t('desktop.chat.quoteToCurrent') : t('desktop.chat.quoteToTarget', { title: preferred.label }) }] : []),
    ...(children.length ? [{ key: 'targets', label: t(preferred ? 'desktop.chat.quoteOtherTarget' : 'desktop.chat.quoteChooseTarget'), children }] : []),
  ]
})
function renderLabel(option: DropdownOption) {
  const label = String(option.label ?? '')
  return h('span', { class: 'resource-selection-menu-option flex w-full min-w-0 items-center gap-5' }, [
    h('span', { class: 'resource-selection-menu-option__label min-w-0 flex-1 truncate' }, label),
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
function prepare(quote: BuddyResourceQuote, x: number, y: number): (() => void) | null {
  if (!mounted || !props.visible || !references)
    return null
  const request = references.capture(props.viewId, quote)
  const ownerKey = props.ownerKey
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
    pending.value = request
  }
}
function open(quote: BuddyResourceQuote, x: number, y: number): boolean {
  const show = prepare(quote, x, y)
  show?.()
  return Boolean(show)
}
function select(targetId: string) {
  const request = pending.value
  close()
  if (!request || !references || !props.visible)
    return
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
function captureMonaco(quote: BuddyResourceQuote): MonacoResourceQuoteMenu | null {
  if (!mounted || !props.visible || !references)
    return null
  const request = references.capture(props.viewId, quote)
  if (!request)
    return { label: t(buddyResourceQuoteSchema.safeParse(quote).success ? 'desktop.chat.quoteTargetChanged' : 'desktop.chat.quoteLimit'), actions: [] }
  const ownerKey = props.ownerKey
  const preferred = request.targets.find(target => target.id === request.defaultId)
  const targets = [...(preferred ? [preferred] : []), ...request.targets.filter(target => target !== preferred)]
  return {
    label: t(targets.length ? 'desktop.chat.quoteToCurrent' : 'desktop.chat.quoteNoTarget'),
    actions: targets.map(target => ({
      label: target.label,
      run: () => {
        if (!mounted || !props.visible || ownerKey !== props.ownerKey) {
          message.warning(t('desktop.chat.quoteTargetChanged'))
          return
        }
        showSelectionReferenceResult(message, t, references.add(request, target.id), target.label)
      },
    })),
  }
}
defineExpose({ open, prepare, close, openRequest, captureMonaco })
</script>

<template>
  <NDropdown
    trigger="manual" placement="bottom-start" :show="pending !== null" :x="position.x" :y="position.y" :options="options"
    size="small" :menu-props="menuProps" :render-label="renderLabel"
    :node-props="option => ({ 'role': 'menuitem', 'aria-label': String(option.label ?? '') })"
    @select="select" @clickoutside="event => event.button !== 2 && close()"
  />
</template>
