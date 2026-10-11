import type { ShallowRef } from 'vue'
import type { ReasoningFieldState } from '../typing'
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { desktopThemeSnapshot } from '@/theme/desktopThemeState'
import { clamp } from './geometry'
import { createReasoningFieldPalette, createReasoningFieldRenderer } from './renderer'

export function useReasoningFieldCanvas(canvas: Readonly<ShallowRef<HTMLCanvasElement | null>>, props: ReasoningFieldState) {
  let animationFrame = 0
  let displayedProgress = props.progress
  let lastFrameTime = 0
  let reducedMotion = false
  let waveMomentum = 0
  let reducedMotionMedia: MediaQueryList | null = null
  let resizeObserver: ResizeObserver | null = null
  const palette = computed(() => {
    const { colors, descriptor } = desktopThemeSnapshot.value.active
    return createReasoningFieldPalette(colors, descriptor.appearance === 'dark')
  })
  const renderField = createReasoningFieldRenderer(document.createElement('canvas'), () => palette.value)
  watch(palette, () => draw(performance.now()))

  watch(() => props.progress, () => {
    if (!reducedMotion)
      return
    displayedProgress = props.progress
    draw(performance.now())
  })

  onMounted(() => {
    reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotion = reducedMotionMedia.matches
    reducedMotionMedia.addEventListener('change', handleReducedMotionChange)
    resizeObserver = new ResizeObserver(resizeCanvas)
    if (canvas.value)
      resizeObserver.observe(canvas.value)
    resizeCanvas()
    syncAnimation()
  })

  onBeforeUnmount(() => {
    cancelAnimationFrame(animationFrame)
    resizeObserver?.disconnect()
    reducedMotionMedia?.removeEventListener('change', handleReducedMotionChange)
  })

  function handleReducedMotionChange(event: MediaQueryListEvent) {
    reducedMotion = event.matches
    displayedProgress = props.progress
    waveMomentum = 0
    syncAnimation()
  }

  function syncAnimation() {
    cancelAnimationFrame(animationFrame)
    animationFrame = 0
    lastFrameTime = 0
    if (reducedMotion) {
      draw(0)
      return
    }
    animationFrame = requestAnimationFrame(renderFrame)
  }

  function renderFrame(time: number) {
    const elapsed = lastFrameTime === 0 ? 16 : Math.min(64, time - lastFrameTime)
    lastFrameTime = time
    const previousProgress = displayedProgress
    const response = props.dragging ? 0.038 : 0.016
    const easing = 1 - Math.exp(-elapsed * response)
    displayedProgress += (props.progress - displayedProgress) * easing
    if (Math.abs(displayedProgress - props.progress) < 0.0005)
      displayedProgress = props.progress
    const momentumTarget = props.dragging
      ? clamp((displayedProgress - previousProgress) * 36, -1, 1)
      : 0
    const momentumResponse = 1 - Math.exp(-elapsed * (props.dragging ? 0.08 : 0.012))
    waveMomentum += (momentumTarget - waveMomentum) * momentumResponse
    if (Math.abs(waveMomentum) < 0.001)
      waveMomentum = 0
    draw(time)
    animationFrame = requestAnimationFrame(renderFrame)
  }

  function resizeCanvas() {
    const element = canvas.value
    if (!element)
      return
    const bounds = element.getBoundingClientRect()
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.round(bounds.width * pixelRatio))
    const height = Math.max(1, Math.round(bounds.height * pixelRatio))
    if (element.width !== width || element.height !== height) {
      element.width = width
      element.height = height
    }
    draw(performance.now())
  }

  function draw(frameTime: number) {
    const element = canvas.value
    const context = element?.getContext('2d')
    if (!element || !context)
      return
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    const width = element.width / pixelRatio
    const height = element.height / pixelRatio
    const progress = clamp(displayedProgress, 0, 1)
    const time = reducedMotion ? 0 : frameTime / 1000

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    context.clearRect(0, 0, width, height)
    renderField(context, {
      width,
      height,
      progress,
      time,
      momentum: waveMomentum,
      dragging: props.dragging,
      dark: desktopThemeSnapshot.value.active.descriptor.appearance === 'dark',
    })
  }
}
