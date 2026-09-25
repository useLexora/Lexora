<script setup lang="ts">
import type { AnchorGeometry, ControlSnapshot, MountGeometry } from '@buddy-shared/workbench/workbenchUi'
import type { ExtensionSurface } from './useExtensionViews'
import type { SurfaceLayout, SurfaceLayoutLease } from '@/shared/ui/surfaces/surfaceLayout'
import { extensionJsonSchema } from '@buddy-shared/extensions/extensionApi'
import { onMounted, onScopeDispose, useTemplateRef, watch } from 'vue'
import { useExtensionContext } from '../extensionContext'
import { extensionErrorCode } from '../state/useExtensionState'

interface Frame {
  element: HTMLIFrameElement
  surface: ExtensionSurface
  layout: SurfaceLayoutLease
  geometry: AnchorGeometry | null
  mount: MountGeometry | null
  visible: boolean
  control: ControlSnapshot | null
  started: number
  ping: { id: string, time: number } | null
}
const props = defineProps<{ layout: SurfaceLayout }>()
const { state, views, anchors, focusView, language, isDark, workbench } = useExtensionContext()
const root = useTemplateRef<HTMLElement>('root')
const frames = new Map<string, Frame>()
function isOverlay(surface: ExtensionSurface) {
  const item = state.installed.value.find(item => item.manifest.id === surface.input.extensionId)
  return !!item?.manifest.permissions.windowEffects && (!!surface.anchor || item.manifest.contributes.views.some(view => view.id === surface.input.viewType && view.location === 'window-overlay'))
}
function send(token: string, frame: Frame, data: Record<string, unknown>) {
  frame.element.contentWindow?.postMessage({ channel: 'lexora-extension', token, ...data }, '*')
}
let lastActivity = 0
onScopeDispose(anchors.onActivity((anchor, activity) => {
  const now = performance.now()
  const windowActivity = anchor.kind === 'composer.input' && now - lastActivity >= 50
  if (windowActivity)
    lastActivity = now
  for (const [token, frame] of frames) {
    if (frame.surface.anchor === anchor && frame.geometry?.visible && frame.surface.ready)
      send(token, frame, { activity })
    else if (windowActivity && !frame.surface.anchor && isOverlay(frame.surface) && frame.visible && frame.surface.ready)
      send(token, frame, { activity: { type: 'composer-input' } })
  }
}))
function environment() {
  const style = root.value ? getComputedStyle(root.value) : null
  const colors = Object.fromEntries(Object.entries({ 'background': '--buddy-surface-canvas', 'text': '--buddy-text-primary', 'muted': '--buddy-text-secondary', 'border': '--buddy-border-subtle', 'accent': '--buddy-nav-foreground', 'accent-solid': '--buddy-accent-solid' }).map(([key, name]) => [key, style?.getPropertyValue(name).trim() || '']))
  return { language: language.value, colorScheme: isDark.value ? 'dark' : 'light', colors }
}
watch([language, isDark], () => {
  for (const [token, frame] of frames) send(token, frame, { environment: environment() })
}, { flush: 'post' })
watch(() => [...views.surfaces.values()].map(surface => surface.control?.snapshot()), () => {
  for (const [token, frame] of frames) {
    const control = frame.surface.control?.snapshot()
    if (control && control !== frame.control) {
      frame.control = control
      send(token, frame, { control })
    }
  }
}, { flush: 'post' })
watch(workbench, () => {
  for (const [token, frame] of frames) send(token, frame, { workbench: workbench.value })
}, { flush: 'post' })
function visibilityChanged() {
  for (const [token, frame] of frames) send(token, frame, { visible: frame.visible && document.visibilityState === 'visible' })
}
function sync() {
  if (!root.value)
    return
  const retained = new Set([...views.surfaces.values()].map(surface => surface.session?.token).filter(Boolean))
  for (const [token, frame] of frames) {
    if (!retained.has(token)) {
      frame.layout.dispose()
      frame.element.remove()
      frames.delete(token)
    }
  }
  for (const surface of views.surfaces.values()) {
    const session = surface.session
    if (!session)
      continue
    const overlay = isOverlay(surface)
    const options = {
      anchor: surface.element,
      visible: surface.visible && surface.eligible,
      interactive: !overlay,
      layer: overlay ? 'decoration' as const : 'content' as const,
      onLayout: (geometry: { visible: boolean, width: number, height: number }) => {
        const frame = frames.get(session.token)
        if (!frame)
          return
        if (frame.visible !== geometry.visible) {
          frame.visible = geometry.visible
          send(session.token, frame, { visible: frame.visible && document.visibilityState === 'visible' })
        }
        if (surface.mount) {
          const bounds = surface.mount.element.getBoundingClientRect()
          const rect = surface.element.getBoundingClientRect()
          const mount = { target: surface.mount.target, visible: geometry.visible, width: bounds.width, height: bounds.height, rect: { x: rect.left - bounds.left, y: rect.top - bounds.top, width: geometry.width, height: geometry.height } }
          if (JSON.stringify(mount) !== JSON.stringify(frame.mount)) {
            frame.mount = mount
            send(session.token, frame, { mount })
          }
        }
        else if (frame.mount?.visible) {
          frame.mount = { ...frame.mount, visible: false, rect: { ...frame.mount.rect, width: 0, height: 0 } }
          send(session.token, frame, { mount: frame.mount })
        }
        if (!surface.anchor)
          return
        const next = { kind: surface.anchor.kind, ...geometry }
        if (JSON.stringify(next) !== JSON.stringify(frame.geometry)) {
          frame.geometry = next
          send(session.token, frame, { anchor: next })
        }
      },
    }
    const existing = frames.get(session.token)
    if (existing) {
      existing.surface = surface
      existing.layout.update(options)
      continue
    }
    const element = document.createElement('iframe')
    element.setAttribute('sandbox', 'allow-scripts allow-forms')
    element.setAttribute('referrerpolicy', 'no-referrer')
    element.setAttribute('allow', 'camera \'none\'; microphone \'none\'; geolocation \'none\'; clipboard-read \'none\'; clipboard-write \'none\'; fullscreen \'none\'')
    element.title = state.installed.value.find(item => item.manifest.id === session.extensionId)?.manifest.name ?? session.extensionId
    element.dataset.extensionView = session.id
    if (overlay)
      element.dataset.extensionOverlay = session.extensionId
    element.style.cssText = 'position:fixed;border:0;visibility:hidden;left:-10000px;width:1px;height:1px'
    frames.set(session.token, { element, surface, layout: props.layout.attach(element, options), geometry: null, mount: null, visible: false, control: surface.control?.snapshot() ?? null, started: performance.now(), ping: null })
    element.src = session.url
    root.value.append(element)
  }
  props.layout.invalidate()
}
async function receive(event: MessageEvent) {
  const data = event.data
  if (!data || data.channel !== 'lexora-extension' || typeof data.token !== 'string')
    return
  const frame = frames.get(data.token)
  const session = frame?.surface.session
  if (!frame || !session || event.source !== frame.element.contentWindow)
    return
  if (typeof data.pong === 'string' && data.pong === frame.ping?.id) {
    frame.ping = null
    return
  }
  if (data.dismiss === true && frame.surface.ready && frame.surface.visible && frame.surface.control) {
    frame.surface.control.dismiss()
    return
  }
  if (typeof data.id !== 'string' || !/^[\da-f-]{36}$/.test(data.id) || typeof data.method !== 'string')
    return
  let value: unknown
  let ok = false
  try {
    if (['resources.pickFiles', 'resources.pickDirectory', 'resources.beginSave'].includes(data.method) && (!frame.visible || document.visibilityState !== 'visible' || !document.hasFocus()))
      throw new Error('EXTENSION_RESOURCE_PICKER_UNAVAILABLE')
    value = await state.api.viewRequest(session.id, session.generation, session.token, data.method, extensionJsonSchema.parse(data.params))
    if (frames.get(data.token) !== frame || frame.surface.session !== session)
      return
    if (data.method === 'bootstrap' && value && typeof value === 'object')
      value = { ...value, workbench: workbench.value, visible: frame.visible && document.visibilityState === 'visible', environment: environment(), anchor: frame.geometry, mount: frame.mount, control: frame.surface.control?.snapshot() ?? null }
    if (data.method === 'view.ready')
      frame.surface.ready = true
    if (data.method === 'view.failed') {
      views.fail(frame.surface, 'EXTENSION_VIEW_FAILED')
      return
    }
    ok = true
  }
  catch (error) {
    value = extensionErrorCode(error)
  }
  if (frames.get(data.token) === frame && frame.surface.session === session)
    send(session.token, frame, { id: data.id, ok, value })
}
function focused() {
  queueMicrotask(() => {
    for (const { element, surface } of frames.values()) {
      if (document.activeElement === element)
        focusView(surface.input.viewId)
    }
  })
}
let heartbeat: ReturnType<typeof setInterval> | undefined
let lastCheck = performance.now()
function checkHealth() {
  const now = performance.now()
  const suspended = document.visibilityState !== 'visible' || now - lastCheck > 3000
  lastCheck = now
  for (const [token, frame] of frames) {
    if (suspended) {
      frame.started = now
      frame.ping = null
      continue
    }
    if (!frame.surface.ready) {
      if (now - frame.started > 10000)
        views.fail(frame.surface, 'EXTENSION_VIEW_TIMEOUT')
      continue
    }
    if (!frame.surface.control)
      continue
    if (!frame.visible) {
      frame.ping = null
      continue
    }
    if (frame.ping && now - frame.ping.time > 3000) {
      views.fail(frame.surface, 'EXTENSION_VIEW_TIMEOUT')
    }
    else if (!frame.ping) {
      frame.ping = { id: crypto.randomUUID(), time: now }
      send(token, frame, { ping: frame.ping.id })
    }
  }
}
watch(() => [...views.surfaces.values()].map(surface => [surface.session, surface.element, surface.visible, surface.eligible, surface.anchor, surface.mount]), sync, { flush: 'post' })
onMounted(() => {
  views.setLayout(sync)
  window.addEventListener('message', receive)
  window.addEventListener('blur', focused)
  document.addEventListener('visibilitychange', visibilityChanged)
  heartbeat = setInterval(checkHealth, 1000)
  sync()
})
onScopeDispose(() => {
  clearInterval(heartbeat)
  views.setLayout(() => {})
  window.removeEventListener('message', receive)
  window.removeEventListener('blur', focused)
  document.removeEventListener('visibilitychange', visibilityChanged)
  for (const frame of frames.values()) {
    frame.layout.dispose()
    frame.element.remove()
  }
  frames.clear()
})
</script>

<template>
  <div ref="root" class="extension-frames" data-testid="extension-frames" />
</template>

<style scoped>
.extension-frames { display: contents; }
</style>
