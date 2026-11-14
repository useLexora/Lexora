<script setup lang="ts">
import type { DropdownOption } from 'naive-ui'
import type { FileLinkMenuAction, FileLinkMenuProvider } from './fileLinkMenu'
import type { MarkdownImageResolver } from './markdownImage'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { localFileLinkPath } from '@buddy-shared/files/fileLink'
import { useEventListener } from '@vueuse/core'
import { NDropdown } from 'naive-ui'
import { computed, ErrorCodes, getCurrentInstance, handleError, onBeforeUnmount, provide, shallowRef, useTemplateRef, watch } from 'vue'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import { desktopThemeSnapshot } from '@/theme/desktopThemeState'
import { markdownThemeVariables } from '@/theme/markdownTheme'
import ChatMarkdownBody from './ChatMarkdownBody.vue'
import { markdownImageContextKey } from './markdownImage'
import { markdownCustomId } from './markdownRenderers'

const props = withDefaults(defineProps<{
  content: string
  openWebLink?: (url: string) => void
  fileLinkMenu?: FileLinkMenuProvider
  onLinkError?: (error: unknown) => void
  allowImages?: boolean
  resolveImage?: MarkdownImageResolver
  codeOverflow?: 'wrap' | 'scroll'
  final?: boolean
  language: BuddyLocale
  writeClipboardText: (text: string) => Promise<void>
}>(), {
  allowImages: true,
  final: true,
})

const emit = defineEmits<{
  openLink: [href: string]
}>()

const { isDark } = useDesktopUi()
provide(markdownImageContextKey, { resolve: computed(() => props.resolveImage), language: computed(() => props.language) })
const themeVariables = computed(() => markdownThemeVariables(desktopThemeSnapshot.value.active.colors))
interface FileLinkMenu {
  x: number
  y: number
  actions: readonly FileLinkMenuAction[]
}

const host = useTemplateRef('host')
const instance = getCurrentInstance()
const fileMenu = shallowRef<FileLinkMenu | null>(null)
let menuGeneration = 0

function dropdownOptions(actions: readonly FileLinkMenuAction[]): DropdownOption[] {
  return actions.map(action => ({
    key: action.key,
    label: action.label,
    disabled: action.disabled,
    children: action.children?.length ? dropdownOptions(action.children) : undefined,
  }))
}

const menuOptions = computed(() => dropdownOptions(fileMenu.value?.actions ?? []))

function closeFileMenu() {
  if (!fileMenu.value)
    return
  menuGeneration++
  fileMenu.value = null
}

function invalidateFileMenu() {
  menuGeneration++
  fileMenu.value = null
}

watch([() => props.content, () => props.fileLinkMenu], invalidateFileMenu, { flush: 'sync' })
onBeforeUnmount(invalidateFileMenu)

useEventListener(document, 'pointerdown', () => {
  if (fileMenu.value && !fileMenu.value.actions.length)
    closeFileMenu()
})
useEventListener(document, 'contextmenu', closeFileMenu, { capture: true })
useEventListener(document, 'keydown', (event) => {
  if (fileMenu.value && (event.key === 'Escape' || event.key === 'Tab'
    || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
    if (event.key === 'Escape')
      event.preventDefault()
    closeFileMenu()
  }
}, { capture: true })

async function openFileMenu(event: MouseEvent | KeyboardEvent) {
  const provider = props.fileLinkMenu
  if (!provider || event.defaultPrevented || !(event.target instanceof Element))
    return
  const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
  const href = anchor?.getAttribute('href')?.trim()
  if (!anchor || !host.value?.contains(anchor) || !href || localFileLinkPath(href) === null)
    return

  event.preventDefault()
  event.stopPropagation()
  menuGeneration++
  const rect = anchor.getBoundingClientRect()
  const keyboard = event instanceof KeyboardEvent
  const request: FileLinkMenu = {
    x: keyboard ? rect.left : event.clientX,
    y: keyboard ? rect.bottom : event.clientY,
    actions: [],
  }
  fileMenu.value = request
  try {
    const actions = await provider(href)
    if (fileMenu.value !== request)
      return
    if (!anchor.isConnected || !actions.length) {
      closeFileMenu()
      return
    }
    fileMenu.value = { ...request, actions }
  }
  catch {
    if (fileMenu.value === request)
      closeFileMenu()
  }
}

function handleFileMenuKeydown(event: KeyboardEvent) {
  if (!event.altKey && !event.ctrlKey && !event.metaKey
    && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
    return openFileMenu(event)
  }
}

function findMenuAction(actions: readonly FileLinkMenuAction[], key: string | number): FileLinkMenuAction | undefined {
  for (const action of actions) {
    if (action.disabled)
      continue
    if (action.children?.length) {
      const child = findMenuAction(action.children, key)
      if (child)
        return child
    }
    else if (action.key === key) {
      return action
    }
  }
}

function selectFileAction(key: string | number) {
  const action = findMenuAction(fileMenu.value?.actions ?? [], key)
  if (!action?.run)
    return
  closeFileMenu()
  const generation = menuGeneration
  void Promise.resolve().then(() => action.run?.()).catch((error: unknown) => {
    if (generation !== menuGeneration)
      return
    if (props.onLinkError) {
      try {
        props.onLinkError(error)
      }
      catch (callbackError) {
        handleError(callbackError, instance, ErrorCodes.COMPONENT_EVENT_HANDLER, false)
      }
    }
    else {
      handleError(error, instance, ErrorCodes.COMPONENT_EVENT_HANDLER, false)
    }
  })
}

function handleLinkClick(event: MouseEvent) {
  if (event.defaultPrevented || !(event.target instanceof Element))
    return

  const anchor = event.target.closest<HTMLAnchorElement>('a')
  if (!anchor)
    return

  event.preventDefault()
  event.stopImmediatePropagation()

  const href = anchor.getAttribute('href')?.trim()
  if (!href)
    return

  if (/^https?:\/\//i.test(href)) {
    if (props.openWebLink)
      props.openWebLink(href)
    else
      window.open(href, '_blank', 'noopener,noreferrer')
    return
  }

  emit('openLink', href)
}
</script>

<template>
  <div
    ref="host"
    class="buddy-chat-markdown-host w-full min-w-0"
    @click="handleLinkClick"
    @contextmenu="openFileMenu"
    @keydown="handleFileMenuKeydown"
  >
    <ChatMarkdownBody
      :theme-variables="themeVariables"
      :content="content"
      :custom-id="markdownCustomId"
      :allow-images="allowImages"
      :code-overflow="codeOverflow"
      :final="final"
      :is-dark="isDark"
      :write-clipboard-text="writeClipboardText"
    />
    <NDropdown
      v-if="fileMenu && menuOptions.length"
      class="buddy-spaced-submenus"
      :show="true"
      :x="fileMenu.x"
      :y="fileMenu.y"
      :options="menuOptions"
      :menu-props="() => ({ role: 'menu' })"
      :node-props="option => ({ 'role': 'menuitem', 'aria-disabled': option.disabled ? 'true' : 'false' })"
      trigger="manual"
      placement="bottom-start"
      @select="selectFileAction"
      @clickoutside="closeFileMenu"
      @update:show="show => { if (!show) closeFileMenu() }"
    />
  </div>
</template>
