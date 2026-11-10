import type { ShallowRef } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import Viewer from 'viewerjs'
import { shallowRef, watch } from 'vue'
import 'viewerjs/dist/viewer.css'

export function useImageViewer(stage: Readonly<ShallowRef<HTMLElement | null>>, source: () => string, name: () => string) {
  const ready = shallowRef(false)
  const failed = shallowRef(false)
  const ratio = shallowRef(1)
  const rotation = shallowRef(0)
  const dimensions = shallowRef({ width: 0, height: 0 })
  let viewer: Viewer | null = null

  function fit() {
    const element = stage.value
    if (!element || !ready.value || !viewer)
      return
    const { width, height } = dimensions.value
    const sideways = Math.abs(rotation.value % 180) === 90
    const scale = Math.min(1, element.clientWidth * 0.94 / (sideways ? height : width), element.clientHeight * 0.94 / (sideways ? width : height))
    viewer.zoomTo(scale, false)
    viewer.moveTo((element.clientWidth - width * scale) / 2, (element.clientHeight - height * scale) / 2)
  }

  function originalSize() {
    viewer?.zoomTo(1, false)
  }

  function toggleSize() {
    if (Math.abs(ratio.value - 1) < 0.001)
      fit()
    else originalSize()
  }

  watch([stage, source], ([element, src], _previous, onCleanup) => {
    ready.value = false
    failed.value = false
    ratio.value = 1
    rotation.value = 0
    if (!element || !src)
      return
    const image = document.createElement('img')
    image.hidden = true
    image.alt = name()
    image.src = src
    element.append(image)
    const instance = new Viewer(image, {
      inline: true,
      button: false,
      navbar: false,
      navigation: false,
      title: false,
      toolbar: false,
      tooltip: false,
      keyboard: false,
      focus: false,
      fullscreen: false,
      backdrop: false,
      transition: false,
      toggleOnDblclick: false,
      zoomOnWheel: true,
      slideOnWheel: false,
      rotateOnTouch: false,
      rotateOnGesture: false,
      minWidth: 0,
      minHeight: 0,
      initialCoverage: 0.94,
      minZoomRatio: 0.01,
      maxZoomRatio: 16,
      view(event) {
        event.detail.image.addEventListener('error', () => {
          failed.value = true
          ready.value = false
        }, { once: true })
      },
      viewed(event) {
        dimensions.value = { width: event.detail.image.naturalWidth, height: event.detail.image.naturalHeight }
        ready.value = true
        fit()
      },
      zoom(event) {
        ratio.value = event.detail.ratio
      },
      rotated(event) {
        rotation.value = event.detail.degree
      },
    })
    viewer = instance
    onCleanup(() => {
      instance.destroy()
      image.remove()
      if (viewer === instance)
        viewer = null
    })
  }, { flush: 'post', immediate: true })

  useResizeObserver(stage, fit)

  return {
    ready,
    failed,
    ratio,
    dimensions,
    fit,
    originalSize,
    toggleSize,
    zoomIn: () => viewer?.zoom(0.25, false),
    zoomOut: () => viewer?.zoom(-0.25, false),
    rotateLeft: () => viewer?.rotate(-90),
    rotateRight: () => viewer?.rotate(90),
  }
}
