import type { ThemeMaterial } from '@buddy-shared/theme/themeDocument'
import { watch } from 'vue'
import { desktopThemeSnapshot } from './desktopThemeState'

function materialImage(material: ThemeMaterial, width: number, height: number, image: HTMLImageElement | null): string {
  const gradient = material.gradient
  const stops = gradient?.stops.map(stop => `<stop offset="${stop.at}%" stop-color="${stop.color}"/>`).join('')
  const fill = material.color ?? '#00000000'
  let illustration = ''
  if (image?.naturalWidth && image.naturalHeight) {
    const scale = Math[material.size === 'cover' ? 'max' : 'min'](width / image.naturalWidth, height / image.naturalHeight) * material.scale
    const w = image.naturalWidth * scale
    const h = image.naturalHeight * scale
    illustration = `<image opacity="${material.imageOpacity}" href="${image.src}" x="${(width - w) * material.position[0] / 100}" y="${(height - h) * material.position[1] / 100}" width="${w}" height="${h}"/>`
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="gradient" gradientTransform="rotate(${(gradient?.angle ?? 90) - 90} .5 .5)">${stops ?? ''}</linearGradient><filter id="blur"><feGaussianBlur stdDeviation="${material.blur}"/></filter></defs><g opacity="${material.opacity}"${material.blur ? ' filter="url(#blur)"' : ''}><rect width="100%" height="100%" fill="${fill}"/>${illustration}${gradient ? '<rect width="100%" height="100%" fill="url(#gradient)"/>' : ''}</g></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

export function useThemeMaterial(anchor: ThemeMaterial['anchor'], element: () => HTMLElement | null): void {
  watch([element, () => desktopThemeSnapshot.value.active], ([target, theme], _, cleanup) => {
    const material = theme.document.materials.find(item => item.anchor === anchor)
    if (!target || !material)
      return
    const previous = target.style.backgroundImage
    const image = material.image && theme.assets[material.image] ? new Image() : null
    const paint = () => {
      if (target.clientWidth && target.clientHeight)
        target.style.backgroundImage = materialImage(material, target.clientWidth, target.clientHeight, image)
    }
    if (image) {
      image.onload = paint
      image.src = theme.assets[material.image!]!
    }
    const observer = new ResizeObserver(paint)
    observer.observe(target)
    paint()
    cleanup(() => {
      observer.disconnect()
      if (image)
        image.onload = null
      target.style.backgroundImage = previous
    })
  }, { immediate: true, flush: 'post' })
}
