import { isRef } from 'vue'

function unwrap(value: unknown): unknown {
  return isRef(value) ? value.value : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

/** Read the real scrollport from a naive-ui scrollbar instance, without searching the document. */
export function readSettingsScrollElement(scrollbar: unknown): HTMLElement | null {
  const inst = unwrap(isRecord(scrollbar) ? scrollbar.scrollbarInstRef : null)
  const container = unwrap(isRecord(inst) ? inst.containerRef : null)
  if (container instanceof HTMLElement)
    return container
  const root = isRecord(scrollbar) ? scrollbar.$el : null
  if (!(root instanceof HTMLElement))
    return null
  if (root.classList.contains('n-scrollbar-container'))
    return root
  const nested = root.querySelector(':scope > .n-scrollbar-container, .n-scrollbar-container')
  return nested instanceof HTMLElement ? nested : null
}
