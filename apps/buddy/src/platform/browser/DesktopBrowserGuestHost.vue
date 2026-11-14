<script setup lang="ts">
import type {
  DesktopBrowserApi,
  DesktopBrowserGuestDescriptor,
} from '@buddy-electron/shared/desktopApi'
import type { BrowserGuestCatalog } from './BrowserGuestCatalog'
import type { SurfaceLayout, SurfaceLayoutLease, SurfaceLayoutOptions } from '@/shared/ui/surfaces/surfaceLayout'
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue'

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
  pageId: string | null
  previous: string | null
}

interface BrowserGuestSurface {
  element: HTMLElement
  sessionId: string
}

onMounted(async () => {
  mounted = true
  presentationId = await props.api.acquirePresentation()
  if (!mounted)
    return
  stopGuestsChanged = watch(props.catalog.snapshot, reconcileGuests, { immediate: true })
  observer = new MutationObserver((records) => {
    if (records.some(record => !(record.target instanceof Element) || !record.target.closest('[data-workbench-surface]')))
      schedulePresentation()
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert'] })
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

function show(sessionId: string, element: HTMLElement): void {
  const previous = surfaces.get(sessionId)
  if (previous?.element === element) {
    scheduleLayout()
    return
  }
  surfaces.set(sessionId, { sessionId, element })
  scheduleLayout()
}

function hide(sessionId: string, element?: HTMLElement): void {
  const current = surfaces.get(sessionId)
  if (!current || (element && current.element !== element))
    return
  surfaces.delete(sessionId)
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
    if (!guests.has(descriptor.sessionId))
      createGuest(descriptor)
  }
  scheduleLayout()
}

function createGuest(descriptor: DesktopBrowserGuestDescriptor): void {
  const host = hostElement.value
  if (!host)
    return

  const element = document.createElement('div')
  const entry: BrowserGuestEntry = { descriptor, element, layout: null!, pageId: null, previous: null }
  entry.layout = props.layout.attach(element, layoutOptions(entry))
  element.className = 'desktop-browser-guest-host__guest'
  element.dataset.browserSessionId = descriptor.sessionId
  guests.set(descriptor.sessionId, entry)
  host.append(element)
}

function layoutOptions(entry: BrowserGuestEntry): SurfaceLayoutOptions {
  const surface = surfaces.get(entry.descriptor.sessionId)
  return { anchor: surface?.element ?? null, visible: !!surface, interactive: false, retainSizeWhenHidden: true, layer: 'content', onLayout: schedulePresentation }
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
  const rect = entry.element.getBoundingClientRect()
  const style = getComputedStyle(entry.element)
  const inset = entry.element.style.clipPath.match(/inset\(([^)]+)\)/)?.[1]?.split(' ').map(Number.parseFloat) ?? [0, 0, 0, 0]
  const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  const clip = { x: rect.x + inset[3]!, y: rect.y + inset[0]!, width: Math.max(0, rect.width - inset[1]! - inset[3]!), height: Math.max(0, rect.height - inset[0]! - inset[2]!) }
  const visible = style.opacity !== '0' && style.visibility !== 'hidden' && !isCovered(entry.element, clip)
  const geometry = JSON.stringify({ bounds, clip, visible })
  if (entry.previous === geometry)
    return
  entry.previous = geometry
  try {
    entry.pageId = entry.descriptor.pageId ?? null
    if (!entry.pageId)
      return
    const snapshot = await props.api.present({ presentationId, sessionId: entry.descriptor.sessionId, pageId: entry.pageId, visible, bounds, clip })
    if (entry.previous !== geometry || !mounted)
      return
    if (visible) {
      entry.element.style.backgroundImage = ''
    }
    else if (snapshot) {
      entry.element.style.backgroundImage = `url("${snapshot}")`
      entry.element.style.backgroundSize = '100% 100%'
    }
  }
  catch {
    entry.previous = null
  }
}

function isCovered(element: HTMLElement, clip: { x: number, y: number, width: number, height: number }): boolean {
  if (document.querySelector('.workbench.is-dragging, .workbench.is-resizing, .desktop-workbench-layout.is-resizing'))
    return true
  const layer = Number.parseInt(element.style.zIndex, 10) || 0
  return [...document.querySelectorAll<HTMLElement>('body *')].some((candidate) => {
    if (candidate === element || candidate.contains(element) || element.contains(candidate))
      return false
    const style = getComputedStyle(candidate)
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0' || (Number.parseInt(style.zIndex, 10) || 0) <= layer)
      return false
    const rect = candidate.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.left < clip.x + clip.width && rect.right > clip.x && rect.top < clip.y + clip.height && rect.bottom > clip.y
  })
}

function removeGuest(entry: BrowserGuestEntry): void {
  entry.layout.dispose()
  if (presentationId && entry.pageId) {
    const zero = { x: 0, y: 0, width: 0, height: 0 }
    void props.api.present({ presentationId, sessionId: entry.descriptor.sessionId, pageId: entry.pageId, visible: false, bounds: zero, clip: zero }).catch(() => {})
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
