<script setup lang="ts">
import type {
  DesktopBrowserApi,
  DesktopBrowserGuestDescriptor,
} from '@buddy-electron/shared/desktopApi'
import type { BrowserGuestCatalog } from './BrowserGuestCatalog'
import type { BrowserGuestSurface } from './browserGuestSurface'
import type { SurfaceLayout, SurfaceLayoutGeometry, SurfaceLayoutLease, SurfaceLayoutOptions } from '@/shared/ui/surfaces/surfaceLayout'
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue'
import { hiddenSurfaceGeometry } from '@/shared/ui/surfaces/surfaceLayout'

import { browserSurfaceOccluded } from './browserSurfaceOcclusion'

const props = defineProps<{
  api: DesktopBrowserApi
  catalog: BrowserGuestCatalog
  layout: SurfaceLayout
}>()

const hostElement = useTemplateRef<HTMLElement>('hostElement')
const guests = new Map<string, BrowserGuestEntry>()
const surfaces = new Map<string, BrowserGuestSurface>()
let mounted = false
let presentationId: string | null = null
let observer: MutationObserver | null = null
let frame = 0
let stopGuestsChanged: (() => void) | null = null

interface BrowserGuestEntry {
  descriptor: DesktopBrowserGuestDescriptor
  element: HTMLElement
  layout: SurfaceLayoutLease
  geometry: SurfaceLayoutGeometry
  pageId: string | null
  previous: { geometry: string, surface?: BrowserGuestSurface } | null
}

onMounted(async () => {
  mounted = true
  presentationId = await props.api.acquirePresentation()
  if (!mounted)
    return
  stopGuestsChanged = watch(props.catalog.snapshot, reconcileGuests, { immediate: true })
  observer = new MutationObserver((records) => {
    if (records.some(record => !(record.target instanceof Element) || !record.target.closest('[data-browser-session-id]')))
      schedulePresentation()
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'open', 'role', 'aria-modal'] })
  document.addEventListener('transitionend', schedulePresentation, true)
  document.addEventListener('animationend', schedulePresentation, true)
  void props.catalog.refresh().catch(() => {})
})

onBeforeUnmount(() => {
  mounted = false
  observer?.disconnect()
  cancelAnimationFrame(frame)
  document.removeEventListener('transitionend', schedulePresentation, true)
  document.removeEventListener('animationend', schedulePresentation, true)
  stopGuestsChanged?.()
  stopGuestsChanged = null
  for (const entry of guests.values())
    removeGuest(entry)
  guests.clear()
})

function show(sessionId: string, surface: BrowserGuestSurface): void {
  surfaces.set(sessionId, surface)
  scheduleLayout()
}

function hide(sessionId: string, surface: BrowserGuestSurface): void {
  if (surfaces.get(sessionId) !== surface)
    return
  surfaces.delete(sessionId)
  const entry = guests.get(sessionId)
  if (entry) {
    entry.geometry = hiddenSurfaceGeometry
    entry.element.style.backgroundImage = ''
    void present(entry)
  }
  scheduleLayout()
}

defineExpose({ hide, show, layout: scheduleLayout })

function reconcileGuests(descriptors: readonly DesktopBrowserGuestDescriptor[] | null): void {
  if (!mounted || !descriptors)
    return

  const nextSessionIds = new Set(descriptors.map(descriptor => descriptor.sessionId))
  for (const [sessionId, entry] of guests) {
    if (!nextSessionIds.has(sessionId)) {
      removeGuest(entry)
      guests.delete(sessionId)
    }
  }
  for (const descriptor of descriptors) {
    const entry = guests.get(descriptor.sessionId)
    if (entry)
      entry.descriptor = descriptor
    else
      createGuest(descriptor)
  }
  scheduleLayout()
}

function createGuest(descriptor: DesktopBrowserGuestDescriptor): void {
  const host = hostElement.value
  if (!host)
    return

  const element = document.createElement('div')
  const entry: BrowserGuestEntry = { descriptor, element, layout: null!, geometry: hiddenSurfaceGeometry, pageId: null, previous: null }
  entry.layout = props.layout.attach(element, layoutOptions(entry))
  element.className = 'desktop-browser-guest-host__guest'
  element.dataset.browserSessionId = descriptor.sessionId
  guests.set(descriptor.sessionId, entry)
  host.append(element)
}

function layoutOptions(entry: BrowserGuestEntry): SurfaceLayoutOptions {
  const surface = surfaces.get(entry.descriptor.sessionId)
  return {
    anchor: surface?.element ?? null,
    visible: !!surface,
    interactive: false,
    retainSizeWhenHidden: true,
    layer: 'content',
    onLayout: (geometry) => {
      entry.geometry = geometry
      void present(entry)
    },
  }
}

function schedulePresentation(): void {
  if (!mounted || frame)
    return
  frame = requestAnimationFrame(() => {
    frame = 0
    for (const entry of guests.values())
      void present(entry)
  })
}

async function present(entry: BrowserGuestEntry): Promise<void> {
  if (!presentationId || guests.get(entry.descriptor.sessionId) !== entry)
    return
  const pageId = entry.descriptor.pageId
  if (!pageId)
    return
  const { bounds, clip } = entry.geometry
  const surface = surfaces.get(entry.descriptor.sessionId)
  const visible = surface?.pageId === pageId && entry.geometry.visible && !browserSurfaceOccluded(clip)
  const geometry = JSON.stringify({ pageId, bounds, clip, visible })
  if (entry.previous?.geometry === geometry && entry.previous.surface === surface)
    return
  const request = { geometry, surface }
  entry.previous = request
  try {
    entry.pageId = pageId
    const snapshot = await props.api.present({ presentationId, sessionId: entry.descriptor.sessionId, pageId: entry.pageId, visible, bounds, clip })
    if (!mounted || guests.get(entry.descriptor.sessionId) !== entry || entry.previous !== request || surfaces.get(entry.descriptor.sessionId) !== surface)
      return
    if (visible) {
      entry.element.style.backgroundImage = ''
      surface.onPresented()
    }
    else if (snapshot && surface?.pageId === pageId) {
      entry.element.style.backgroundImage = `url("${snapshot}")`
      entry.element.style.backgroundSize = '100% 100%'
    }
  }
  catch {
    if (entry.previous === request)
      entry.previous = null
  }
}

function removeGuest(entry: BrowserGuestEntry): void {
  entry.layout.dispose()
  if (presentationId && entry.pageId) {
    void props.api.present({ presentationId, sessionId: entry.descriptor.sessionId, pageId: entry.pageId, ...hiddenSurfaceGeometry }).catch(() => {})
  }
  entry.element.remove()
}

function scheduleLayout(): void {
  for (const entry of guests.values()) {
    entry.layout.update(layoutOptions(entry))
  }
  props.layout.invalidate()
}
</script>

<template>
  <div
    ref="hostElement"
    class="desktop-browser-guest-host contents"
    data-testid="desktop-browser-guest-host"
  />
</template>
