<script setup lang="ts">
import type { ExtensionViewHostMessage, ExtensionViewNotification } from '@buddy-shared/extensions/extensionEvents'
import type { ViewEnvironment } from '@buddy-shared/extensions/extensionViewEvents'
import type { AnchorGeometry, MountGeometry } from '@buddy-shared/workbench/workbenchUi'
import type { ExtensionSurface } from './useExtensionViews'
import type { SurfaceLayout, SurfaceLayoutLease } from '@/shared/ui/surfaces/surfaceLayout'
import { parseExtensionRequestParams } from '@buddy-shared/extensions/extensionApi'
import { onMounted, onScopeDispose, useTemplateRef, watch } from 'vue'
import { SurfaceHitRegions } from '@/workbench/browser/surfaces/SurfaceHitRegions'
import { useExtensionContext } from '../extensionContext'
import { extensionErrorCode } from '../state/useExtensionState'
import { ExtensionViewProjection } from './ExtensionViewProjection'
import { useExtensionFrameEvents } from './useExtensionFrameEvents'

interface Frame {
  element: HTMLIFrameElement
  surface: ExtensionSurface
  layout: SurfaceLayoutLease
  hitRegions: SurfaceHitRegions | null
  geometry: AnchorGeometry | null
  mount: MountGeometry | null
  visible: boolean
  projection: ExtensionViewProjection
  started: number
  ping: { id: string, time: number } | null
}
const props = defineProps<{ layout: SurfaceLayout }>()
const context = useExtensionContext()
const { state, views, endInteraction, focusView, language, isDark, themeColors, workbench } = context
const root = useTemplateRef<HTMLElement>('root')
const frames = new Map<string, Frame>()
function isOverlay(surface: ExtensionSurface) {
  const item = state.installed.value.find(item => item.manifest.id === surface.input.extensionId)
  return !!item?.manifest.permissions.windowEffects && (!!surface.anchor || item.manifest.contributes.views.some(view => view.id === surface.input.viewType && view.location === 'window-overlay'))
}
function send(token: string, frame: Frame, data: ExtensionViewHostMessage) {
  frame.element.contentWindow?.postMessage({ channel: 'lexora-extension', token, ...data }, '*')
}
function notify(_token: string, frame: Frame, event: ExtensionViewNotification) {
  frame.projection.publish(event)
}
function environment(): ViewEnvironment {
  return { language: language.value, colorScheme: isDark.value ? 'dark' : 'light', colors: themeColors.value, themeRevision: context.themeRevision?.value ?? 0 }
}
const projections = useExtensionFrameEvents({ context, frames, environment, isOverlay })
function visibilityChanged() {
  for (const [token, frame] of frames) notify(token, frame, { type: 'view:visibility:changed', data: { visible: frame.visible && document.visibilityState === 'visible' } })
}
function sync() {
  if (!root.value)
    return
  const retained = new Set([...views.surfaces.values()].map(surface => surface.session?.token).filter(Boolean))
  for (const [token, frame] of frames) {
    if (!retained.has(token)) {
      frame.projection.dispose()
      frame.hitRegions?.dispose()
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
      interactive: !overlay && surface.interactionMode !== 'regions',
      layer: overlay ? 'decoration' as const : 'content' as const,
      onLayout: (geometry: { visible: boolean, width: number, height: number }) => {
        const frame = frames.get(session.token)
        if (!frame)
          return
        if (frame.visible !== geometry.visible) {
          frame.visible = geometry.visible
          notify(session.token, frame, { type: 'view:visibility:changed', data: { visible: frame.visible && document.visibilityState === 'visible' } })
        }
        if (surface.mount) {
          const bounds = surface.mount.element.getBoundingClientRect()
          const rect = surface.element.getBoundingClientRect()
          const mount = { target: surface.mount.target, instanceId: surface.mount.instanceId, visible: geometry.visible, width: bounds.width, height: bounds.height, rect: { x: rect.left - bounds.left, y: rect.top - bounds.top, width: geometry.width, height: geometry.height } }
          if (JSON.stringify(mount) !== JSON.stringify(frame.mount)) {
            frame.mount = mount
            notify(session.token, frame, { type: 'view:mount:changed', data: { mount } })
          }
        }
        else if (frame.mount?.visible) {
          frame.mount = { ...frame.mount, visible: false, rect: { ...frame.mount.rect, width: 0, height: 0 } }
          notify(session.token, frame, { type: 'view:mount:changed', data: { mount: frame.mount } })
        }
        if (!surface.anchor)
          return
        const next = { kind: surface.anchor.kind, ...geometry }
        if (JSON.stringify(next) !== JSON.stringify(frame.geometry)) {
          frame.geometry = next
          notify(session.token, frame, { type: 'view:anchor:changed', data: { anchor: next } })
        }
      },
    }
    const existing = frames.get(session.token)
    if (existing) {
      existing.surface = surface
      existing.layout.update(options)
      existing.hitRegions?.update({ ...options, visible: options.visible && surface.ready, onLayout: undefined }, surface.regions)
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
    const hitRegions = surface.interactionMode === 'regions'
      ? new SurfaceHitRegions(props.layout, { ...options, visible: false }, (activation) => {
          const frame = frames.get(session.token)
          if (frame?.visible && frame.surface.ready && frame.surface.eligible)
            notify(session.token, frame, { type: 'interaction:activated', data: { regionId: activation.id, x: activation.x, y: activation.y } })
        })
      : null
    const projection = new ExtensionViewProjection({ workbench: workbench.value, environment: environment(), visible: false, anchor: null, mount: null, control: surface.control?.snapshot() ?? null }, { decoration: overlay, control: !!surface.control, interaction: !!surface.input.interactionId })
    const frame: Frame = { element, hitRegions, surface, layout: props.layout.attach(element, options), geometry: null, mount: null, visible: false, projection, started: performance.now(), ping: null }
    projection.onDidChange(event => send(session.token, frame, event))
    frames.set(session.token, frame)
    element.src = session.url
    root.value.append(element)
    if (hitRegions) {
      root.value.append(hitRegions.element)
      hitRegions.update({ ...options, visible: options.visible && surface.ready }, surface.regions)
    }
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
  if (data.endInteraction === true && frame.surface.input.interactionId) {
    endInteraction(frame.surface.input.interactionId)
    return
  }
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
    if (data.method === 'events.snapshot') {
      projections.refresh(frame)
      value = frame.projection.synchronization
    }
    else {
      value = await state.api.viewRequest(session.id, session.generation, session.token, data.method, parseExtensionRequestParams(data.method, data.params))
    }
    if (frames.get(data.token) !== frame || frame.surface.session !== session)
      return
    if (data.method === 'bootstrap' && value && typeof value === 'object') {
      projections.refresh(frame)
      const { snapshot, ...eventCursor } = frame.projection.synchronization
      value = { ...value, ...snapshot, eventCursor }
    }
    if (data.method === 'view.ready') {
      frame.surface.ready = true
      sync()
    }
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
    frame.projection.dispose()
    frame.hitRegions?.dispose()
    frame.layout.dispose()
    frame.element.remove()
  }
  frames.clear()
})
</script>

<template>
  <div ref="root" class="extension-frames contents" data-testid="extension-frames" />
</template>
