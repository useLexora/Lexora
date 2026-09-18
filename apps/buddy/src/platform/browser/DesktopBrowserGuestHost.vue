<script setup lang="ts">
import type {
  DesktopBrowserApi,
  DesktopBrowserGuestDescriptor,
} from '@buddy-electron/shared/desktopApi'
import type { WebviewTag } from 'electron'
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue'

const props = defineProps<{
  api: DesktopBrowserApi
}>()

const hostElement = useTemplateRef<HTMLElement>('hostElement')
const guests = new Map<string, BrowserGuestEntry>()
const surfaces = new Map<string, BrowserGuestSurface>()
let animationFrame: number | null = null
let mounted = false
let refreshSequence = 0
let resizeObserver: ResizeObserver | null = null
let stopGuestsChanged: (() => void) | null = null

interface BrowserGuestEntry {
  descriptor: DesktopBrowserGuestDescriptor
  element: WebviewTag
  onDestroyed: () => void
  onReady: () => void
}

interface BrowserGuestSurface {
  element: HTMLElement
  sessionId: string
}

onMounted(() => {
  mounted = true
  stopGuestsChanged = props.api.onGuestsChanged(scheduleRefresh)
  window.addEventListener('resize', scheduleLayout)
  document.addEventListener('scroll', scheduleLayout, true)
  scheduleRefresh()
})

onBeforeUnmount(() => {
  mounted = false
  refreshSequence += 1
  stopGuestsChanged?.()
  stopGuestsChanged = null
  resizeObserver?.disconnect()
  resizeObserver = null
  window.removeEventListener('resize', scheduleLayout)
  document.removeEventListener('scroll', scheduleLayout, true)
  if (animationFrame !== null)
    cancelAnimationFrame(animationFrame)
  animationFrame = null
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
  if (previous)
    resizeObserver?.unobserve(previous.element)
  resizeObserver ??= new ResizeObserver(scheduleLayout)
  surfaces.set(sessionId, { sessionId, element })
  resizeObserver.observe(element)
  scheduleLayout()
}

function hide(sessionId: string, element?: HTMLElement): void {
  const current = surfaces.get(sessionId)
  if (!current || (element && current.element !== element))
    return
  resizeObserver?.unobserve(current.element)
  surfaces.delete(sessionId)
  parkGuest(sessionId)
}

defineExpose({ hide, show, layout: scheduleLayout })

function scheduleRefresh(): void {
  void refreshGuests(++refreshSequence)
}

async function refreshGuests(sequence: number): Promise<void> {
  const descriptors = await props.api.listGuests().catch(() => null)
  if (!mounted || sequence !== refreshSequence || !descriptors)
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

  const element = document.createElement('webview') as WebviewTag
  const entry: BrowserGuestEntry = {
    descriptor,
    element,
    onReady: () => {
      if (guests.get(descriptor.sessionId)?.element !== element)
        return
      element.removeEventListener('dom-ready', entry.onReady)
      void props.api.attachGuest(descriptor.sessionId, element.getWebContentsId())
        .catch(() => {
          const current = guests.get(descriptor.sessionId)
          if (current?.element !== element)
            return
          removeGuest(current)
          guests.delete(descriptor.sessionId)
          scheduleRefresh()
        })
    },
    onDestroyed: () => {
      const current = guests.get(descriptor.sessionId)
      if (current?.element !== element)
        return
      removeGuest(current)
      guests.delete(descriptor.sessionId)
      scheduleRefresh()
    },
  }
  element.className = 'desktop-browser-guest-host__guest'
  element.dataset.browserSessionId = descriptor.sessionId
  element.setAttribute('partition', descriptor.partition)
  element.setAttribute('src', 'about:blank')
  element.addEventListener('destroyed', entry.onDestroyed)
  element.addEventListener('dom-ready', entry.onReady)
  guests.set(descriptor.sessionId, entry)
  parkElement(element)
  host.append(element)
}

function removeGuest(entry: BrowserGuestEntry): void {
  entry.element.removeEventListener('destroyed', entry.onDestroyed)
  entry.element.removeEventListener('dom-ready', entry.onReady)
  entry.element.remove()
}

function parkGuest(sessionId: string): void {
  const entry = guests.get(sessionId)
  if (entry)
    parkElement(entry.element)
}

function parkElement(element: WebviewTag): void {
  Object.assign(element.style, {
    height: '1px',
    left: '-10000px',
    pointerEvents: 'none',
    position: 'absolute',
    top: '0',
    visibility: 'hidden',
    width: '1px',
  })
}

function scheduleLayout(): void {
  if (!mounted || animationFrame !== null)
    return
  animationFrame = requestAnimationFrame(() => {
    animationFrame = null
    updateLayout()
  })
}

function updateLayout(): void {
  for (const [sessionId, entry] of guests) {
    const surface = surfaces.get(sessionId)
    const rect = surface?.element.isConnected ? surface.element.getBoundingClientRect() : null
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      parkElement(entry.element)
      continue
    }
    Object.assign(entry.element.style, {
      height: `${rect.height}px`,
      left: `${rect.left}px`,
      pointerEvents: 'auto',
      position: 'absolute',
      top: `${rect.top}px`,
      visibility: 'visible',
      width: `${rect.width}px`,
    })
  }
}
</script>

<template>
  <div
    ref="hostElement"
    class="desktop-browser-guest-host"
    data-testid="desktop-browser-guest-host"
  />
</template>

<style scoped>
.desktop-browser-guest-host {
  position: fixed;
  z-index: 1;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
</style>
