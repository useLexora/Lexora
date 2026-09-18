<script setup lang="ts">
import type { ExtensionSurface } from './useExtensionViews'
import { extensionJsonSchema } from '@buddy-shared/extensions/extensionApi'
import { onMounted, onScopeDispose, useTemplateRef, watch } from 'vue'
import { useExtensionContext } from '../extensionContext'
import { extensionErrorCode } from '../state/useExtensionState'

const { state, views, focusView, language, isDark } = useExtensionContext()
const root = useTemplateRef<HTMLElement>('root')
const frames = new Map<string, { element: HTMLIFrameElement, surface: ExtensionSurface }>()
let resize: ResizeObserver | null = null
let scheduled = 0
function isOverlay(surface: ExtensionSurface) {
  const item = state.installed.value.find(item => item.manifest.id === surface.input.extensionId)
  return !!item?.manifest.permissions.windowEffects && item.manifest.contributes.views.some(view => view.id === surface.input.viewType && view.location === 'window-overlay')
}
let lastActivity = 0
function typing(event: Event) {
  if (!event.isTrusted || !(event.target instanceof HTMLElement) || !event.target.closest('[data-lexora-composer]') || document.visibilityState !== 'visible' || !document.hasFocus() || matchMedia('(prefers-reduced-motion: reduce)').matches)
    return
  const now = performance.now()
  if (now - lastActivity < 50)
    return
  lastActivity = now
  for (const [token, frame] of frames) {
    if (isOverlay(frame.surface) && frame.surface.visible)
      frame.element.contentWindow?.postMessage({ channel: 'lexora-extension', token, activity: { type: 'composer-input' } }, '*')
  }
}
function environment() {
  const style = root.value ? getComputedStyle(root.value) : null
  const colors = Object.fromEntries(Object.entries({ 'background': '--buddy-surface-canvas', 'text': '--buddy-text-primary', 'muted': '--buddy-text-secondary', 'border': '--buddy-border-subtle', 'accent': '--buddy-nav-foreground', 'accent-solid': '--buddy-accent-solid' }).map(([key, name]) => [key, style?.getPropertyValue(name).trim() || '']))
  return { language: language.value, colorScheme: isDark.value ? 'dark' : 'light', colors }
}
watch([language, isDark], () => {
  for (const [token, frame] of frames)
    frame.element.contentWindow?.postMessage({ channel: 'lexora-extension', token, environment: environment() }, '*')
}, { flush: 'post' })
function layout() {
  if (scheduled)
    return
  scheduled = requestAnimationFrame(() => {
    scheduled = 0
    for (const { element, surface } of frames.values()) {
      const bounds = surface.element.isConnected && surface.visible ? surface.element.getBoundingClientRect() : null
      const shown = bounds && bounds.width > 0 && bounds.height > 0
      const overlay = isOverlay(surface)
      Object.assign(element.style, { visibility: shown ? 'visible' : 'hidden', pointerEvents: shown && !overlay ? 'auto' : 'none', zIndex: overlay ? '1' : '0', left: `${shown ? bounds.left : -10000}px`, top: `${shown ? bounds.top : 0}px`, width: `${shown ? bounds.width : 1}px`, height: `${shown ? bounds.height : 1}px` })
      element.tabIndex = shown && !overlay ? 0 : -1
      element.inert = overlay
      if (overlay)
        element.setAttribute('aria-hidden', 'true')
    }
  })
}
function sync() {
  if (!root.value)
    return
  const retained = new Set([...views.surfaces.values()].map(surface => surface.session?.token).filter(Boolean))
  for (const [token, frame] of frames) {
    if (!retained.has(token)) {
      frame.element.remove()
      frames.delete(token)
    }
  }
  resize?.disconnect()
  for (const surface of views.surfaces.values()) {
    resize?.observe(surface.element)
    const session = surface.session
    if (!session || frames.has(session.token))
      continue
    const element = document.createElement('iframe')
    element.setAttribute('sandbox', 'allow-scripts allow-forms')
    element.setAttribute('referrerpolicy', 'no-referrer')
    element.setAttribute('allow', 'camera \'none\'; microphone \'none\'; geolocation \'none\'; clipboard-read \'none\'; clipboard-write \'none\'; fullscreen \'none\'')
    element.title = state.installed.value.find(item => item.manifest.id === session.extensionId)?.manifest.name ?? session.extensionId
    element.dataset.extensionView = session.id
    if (isOverlay(surface))
      element.dataset.extensionOverlay = session.extensionId
    element.style.cssText = 'position:absolute;border:0;visibility:hidden;left:-10000px;width:1px;height:1px'
    frames.set(session.token, { element, surface })
    element.src = session.url
    root.value.append(element)
  }
  layout()
}
async function receive(event: MessageEvent) {
  const data = event.data
  if (!data || data.channel !== 'lexora-extension' || typeof data.token !== 'string')
    return
  const frame = frames.get(data.token)
  const session = frame?.surface.session
  if (!frame || !session || event.source !== frame.element.contentWindow || typeof data.id !== 'string' || !/^[\da-f-]{36}$/.test(data.id) || typeof data.method !== 'string')
    return
  let value: unknown
  let ok = false
  try {
    value = await state.api.viewRequest(session.id, session.generation, session.token, data.method, extensionJsonSchema.parse(data.params))
    if (data.method === 'bootstrap' && value && typeof value === 'object')
      value = { ...value, environment: environment() }
    ok = true
    if (data.method === 'view.failed') {
      frame.surface.error = 'EXTENSION_VIEW_FAILED'
      frame.surface.session = null
      void state.api.closeView(session.id, session.generation, session.token).catch(() => {})
    }
  }
  catch (error) {
    value = extensionErrorCode(error)
  }
  if (frames.get(data.token) !== frame || frame.surface.session !== session)
    return
  frame.element.contentWindow?.postMessage({ channel: 'lexora-extension', token: session.token, id: data.id, ok, value }, '*')
}
function focused() {
  queueMicrotask(() => {
    for (const { element, surface } of frames.values()) {
      if (document.activeElement === element)
        focusView(surface.input.viewId)
    }
  })
}
watch(() => [...views.surfaces.values()].map(surface => [surface.session, surface.element, surface.visible]), sync, { flush: 'post' })
onMounted(() => {
  resize = new ResizeObserver(layout)
  views.setLayout(layout)
  window.addEventListener('message', receive)
  window.addEventListener('resize', layout)
  window.addEventListener('blur', focused)
  document.addEventListener('scroll', layout, true)
  document.addEventListener('input', typing, true)
  sync()
})
onScopeDispose(() => {
  views.setLayout(() => {})
  resize?.disconnect()
  cancelAnimationFrame(scheduled)
  window.removeEventListener('message', receive)
  window.removeEventListener('resize', layout)
  window.removeEventListener('blur', focused)
  document.removeEventListener('scroll', layout, true)
  document.removeEventListener('input', typing, true)
  for (const { element } of frames.values()) element.remove()
  frames.clear()
})
</script>

<template>
  <div ref="root" class="extension-frames" data-testid="extension-frames" />
</template>

<style scoped>
.extension-frames { position: fixed; z-index: 1; inset: 0; overflow: hidden; pointer-events: none; }
:global(body:has(.workbench.is-dragging) .extension-frames iframe) { pointer-events: none !important; }
</style>
