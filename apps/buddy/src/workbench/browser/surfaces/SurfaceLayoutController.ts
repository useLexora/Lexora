import type { SurfaceLayout, SurfaceLayoutLease, SurfaceLayoutOptions } from '@/shared/ui/surfaces/surfaceLayout'

interface SurfaceEntry {
  element: HTMLElement
  options: SurfaceLayoutOptions
  observed: HTMLElement[]
}

export class SurfaceLayoutController implements SurfaceLayout {
  readonly #entries = new Map<HTMLElement, SurfaceEntry>()
  readonly #observed = new Map<HTMLElement, number>()
  #resize: ResizeObserver | null = null
  #mutation: MutationObserver | null = null
  #observationChanged = true
  #queued = false
  #started = false

  start(): void {
    if (this.#started)
      return
    this.#started = true
    this.#resize = new ResizeObserver(this.invalidate)
    this.#mutation = new MutationObserver(this.invalidate)
    for (const element of this.#observed.keys()) this.#resize.observe(element)
    window.addEventListener('resize', this.invalidate)
    document.addEventListener('scroll', this.invalidate, true)
    this.invalidate()
  }

  attach(element: HTMLElement, options: SurfaceLayoutOptions): SurfaceLayoutLease {
    if (this.#entries.has(element))
      throw new Error('Surface is already attached')
    const entry: SurfaceEntry = { element, options, observed: [] }
    this.#entries.set(element, entry)
    element.dataset.workbenchSurface = ''
    this.#park(element)
    this.#observe(entry)
    this.invalidate()
    return {
      update: (next) => {
        if (this.#entries.get(element) !== entry)
          return
        entry.options = next
        this.#observe(entry)
        if (!next.visible || !next.anchor)
          this.#park(element)
        this.invalidate()
      },
      dispose: () => {
        if (this.#entries.get(element) !== entry)
          return
        this.#entries.delete(element)
        this.#unobserve(entry)
        this.#park(element)
        delete element.dataset.workbenchSurface
        this.invalidate()
      },
    }
  }

  readonly invalidate = (): void => {
    if (!this.#started || this.#queued)
      return
    this.#queued = true
    queueMicrotask(() => {
      this.#queued = false
      if (!this.#started)
        return
      if (this.#observationChanged) {
        this.#mutation?.disconnect()
        for (const element of this.#observed.keys()) this.#mutation?.observe(element, { attributes: true, attributeFilter: ['hidden', 'inert', 'class', 'style'] })
        this.#observationChanged = false
      }
      for (const entry of this.#entries.values()) this.#layout(entry)
    })
  }

  dispose(): void {
    this.#started = false
    window.removeEventListener('resize', this.invalidate)
    document.removeEventListener('scroll', this.invalidate, true)
    this.#resize?.disconnect()
    this.#resize = null
    this.#mutation?.disconnect()
    this.#mutation = null
    this.#observationChanged = true
    this.#queued = false
    for (const { element } of this.#entries.values()) this.#park(element)
    this.#entries.clear()
    this.#observed.clear()
  }

  #observe(entry: SurfaceEntry): void {
    const parents: HTMLElement[] = []
    for (let element = entry.options.anchor; element; element = element.parentElement) parents.push(element)
    if (parents.length === entry.observed.length && parents.every((element, index) => element === entry.observed[index]))
      return
    this.#unobserve(entry)
    entry.observed = parents
    for (const element of parents) {
      const count = this.#observed.get(element) ?? 0
      this.#observed.set(element, count + 1)
      if (!count) {
        this.#resize?.observe(element)
        this.#observationChanged = true
      }
    }
  }

  #unobserve(entry: SurfaceEntry): void {
    for (const element of entry.observed) {
      const count = this.#observed.get(element) ?? 0
      if (count > 1) {
        this.#observed.set(element, count - 1)
      }
      else {
        this.#observed.delete(element)
        this.#resize?.unobserve(element)
        this.#observationChanged = true
      }
    }
    entry.observed = []
  }

  #park(element: HTMLElement): void {
    Object.assign(element.style, { position: 'fixed', visibility: 'hidden', pointerEvents: 'none', left: '-10000px', top: '0', width: '1px', height: '1px', clipPath: 'none' })
    element.tabIndex = -1
    element.inert = true
    element.setAttribute('aria-hidden', 'true')
  }

  #layout({ element, options }: SurfaceEntry): void {
    const anchor = options.anchor
    if (!options.visible || !anchor?.isConnected || anchor.closest('[hidden], [inert]') || getComputedStyle(anchor).visibility === 'hidden') {
      this.#park(element)
      options.onLayout?.({ visible: false, width: 0, height: 0 })
      return
    }
    const bounds = anchor.getBoundingClientRect()
    const clip = { left: Math.max(0, bounds.left), top: Math.max(0, bounds.top), right: Math.min(window.innerWidth, bounds.right), bottom: Math.min(window.innerHeight, bounds.bottom) }
    let layer = 0
    for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      layer = Math.max(layer, Number.parseInt(style.zIndex, 10) || 0)
      const rect = parent.getBoundingClientRect()
      const scaleX = parent.offsetWidth ? rect.width / parent.offsetWidth : 1
      const scaleY = parent.offsetHeight ? rect.height / parent.offsetHeight : 1
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        const left = rect.left + parent.clientLeft * scaleX
        clip.left = Math.max(clip.left, left)
        clip.right = Math.min(clip.right, left + parent.clientWidth * scaleX)
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        const top = rect.top + parent.clientTop * scaleY
        clip.top = Math.max(clip.top, top)
        clip.bottom = Math.min(clip.bottom, top + parent.clientHeight * scaleY)
      }
    }
    if (clip.right <= clip.left || clip.bottom <= clip.top) {
      this.#park(element)
      options.onLayout?.({ visible: false, width: 0, height: 0 })
      return
    }
    Object.assign(element.style, {
      position: 'fixed',
      visibility: 'visible',
      pointerEvents: options.interactive && !options.childrenOnly ? 'auto' : 'none',
      left: `${bounds.left}px`,
      top: `${bounds.top}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
      zIndex: String(layer + (options.layer === 'decoration' ? 2 : 1)),
      clipPath: `inset(${clip.top - bounds.top}px ${bounds.right - clip.right}px ${bounds.bottom - clip.bottom}px ${clip.left - bounds.left}px)`,
    })
    options.onLayout?.({ visible: true, width: bounds.width, height: bounds.height })
    element.tabIndex = options.interactive && !options.childrenOnly ? 0 : -1
    element.inert = !options.interactive
    if (options.interactive)
      element.removeAttribute('aria-hidden')
    else
      element.setAttribute('aria-hidden', 'true')
  }
}
