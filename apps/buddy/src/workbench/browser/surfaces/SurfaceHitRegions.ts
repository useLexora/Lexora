import type { WorkbenchHitRegion, WorkbenchRegionActivation } from '@buddy-shared/workbench/workbenchInteraction'
import type { SurfaceLayout, SurfaceLayoutLease, SurfaceLayoutOptions } from '@/shared/ui/surfaces/surfaceLayout'

export class SurfaceHitRegions {
  readonly element = document.createElement('div')
  readonly #lease: SurfaceLayoutLease
  #regions: readonly WorkbenchHitRegion[] = []
  #visible = false
  constructor(layout: SurfaceLayout, options: SurfaceLayoutOptions, readonly activate: (event: WorkbenchRegionActivation) => void) {
    this.element.dataset.workbenchHitRegions = ''
    this.#lease = layout.attach(this.element, this.#options(options))
  }

  update(options: SurfaceLayoutOptions, regions: readonly WorkbenchHitRegion[]): void {
    this.#lease.update(this.#options(options))
    if (regions === this.#regions)
      return
    this.#regions = regions
    const buttons = regions.map((region) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.hitRegion = region.id
      button.setAttribute('aria-label', region.label)
      Object.assign(button.style, { position: 'absolute', left: `${region.rect.x}px`, top: `${region.rect.y}px`, width: `${region.rect.width}px`, height: `${region.rect.height}px`, padding: '0', border: '0', background: 'transparent', pointerEvents: 'auto', cursor: 'pointer' })
      button.addEventListener('click', (event) => {
        if (!event.isTrusted || !this.#visible || !this.#regions.includes(region))
          return
        const bounds = this.element.getBoundingClientRect()
        this.activate({ id: region.id, x: event.detail ? event.clientX - bounds.left : region.rect.x + region.rect.width / 2, y: event.detail ? event.clientY - bounds.top : region.rect.y + region.rect.height / 2 })
      })
      return button
    })
    this.element.replaceChildren(...buttons)
  }

  #options(options: SurfaceLayoutOptions): SurfaceLayoutOptions {
    this.#visible = options.visible
    return { ...options, interactive: true, childrenOnly: true, onLayout: (geometry) => {
      this.#visible = geometry.visible
    } }
  }

  dispose(): void {
    this.#visible = false
    this.#regions = []
    this.#lease.dispose()
    this.element.remove()
  }
}
