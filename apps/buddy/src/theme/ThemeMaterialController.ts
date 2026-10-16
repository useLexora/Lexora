import type { ThemeMaterial } from '@buddy-shared/theme/themeDocument'
import type { SemanticAnchor, WorkbenchAnchors } from '@/shared/ui/contributions/workbenchUiContext'
import { watch } from 'vue'
import { desktopThemeSnapshot } from './desktopThemeState'

function createMaterialLayer(anchor: SemanticAnchor) {
  const layer = document.createElement('div')
  layer.className = 'buddy-theme-material'
  layer.dataset.themeMaterial = anchor.kind
  layer.setAttribute('aria-hidden', 'true')
  const group = document.createElement('div')
  const image = document.createElement('div')
  const gradient = document.createElement('div')
  group.className = 'buddy-theme-material__group'
  image.className = 'buddy-theme-material__image'
  gradient.className = 'buddy-theme-material__gradient'
  group.append(image, gradient)
  layer.append(group)
  anchor.element.prepend(layer)
  return {
    update(material: Omit<ThemeMaterial, 'image'>, source?: string) {
      group.style.backgroundColor = material.color ?? ''
      group.style.opacity = String(material.opacity)
      group.style.filter = material.blur ? `blur(${material.blur}px)` : ''
      image.style.backgroundImage = source ? `url(${JSON.stringify(source)})` : ''
      image.style.backgroundSize = material.size
      image.style.backgroundPosition = material.position.map(value => `${value}%`).join(' ')
      image.style.opacity = String(material.imageOpacity)
      image.style.transform = `scale(${material.scale})`
      image.style.transformOrigin = image.style.backgroundPosition
      const value = material.gradient
      gradient.style.backgroundImage = value ? `linear-gradient(${value.angle}deg, ${value.stops.map(stop => `${stop.color} ${stop.at}%`).join(', ')})` : ''
    },
    dispose: () => layer.remove(),
  }
}

export class ThemeMaterialController {
  readonly #layers = new Map<string, ReturnType<typeof createMaterialLayer>>()
  readonly #stop: () => void

  constructor(anchors: WorkbenchAnchors) {
    this.#stop = watch([() => [...anchors.entries.values()], () => desktopThemeSnapshot.value.active], ([entries, theme]) => {
      const active = new Set<string>()
      for (const anchor of entries) {
        const material = theme.document.materials.find(item => item.anchor === anchor.kind)
        if (!material)
          continue
        active.add(anchor.id)
        let layer = this.#layers.get(anchor.id)
        if (!layer) {
          layer = createMaterialLayer(anchor)
          this.#layers.set(anchor.id, layer)
        }
        layer.update(material, material.image ? theme.assets[material.image] : undefined)
      }
      for (const [id, layer] of this.#layers) {
        if (!active.has(id)) {
          layer.dispose()
          this.#layers.delete(id)
        }
      }
    }, { immediate: true, flush: 'post' })
  }

  dispose(): void {
    this.#stop()
    for (const layer of this.#layers.values())
      layer.dispose()
    this.#layers.clear()
  }
}
