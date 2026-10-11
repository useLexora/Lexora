import type { ThemeColors } from '@buddy-shared/theme/themeDocument'
import { mixThemeColor } from '@buddy-shared/theme/resolveTheme'
import { clamp, createWavePoints, particles, threads, waveBoundaryOffset } from './geometry'

const alpha = (color: string, opacity: number) => `${color.slice(0, 7)}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`

export function createReasoningFieldPalette(colors: ThemeColors, dark: boolean) {
  const { canvas, raised, accent, gold, strong } = colors
  const field: Array<[number, string]> = dark
    ? [[0, mixThemeColor(canvas, accent, 0.08)], [0.28, mixThemeColor(canvas, accent, 0.3)], [0.56, mixThemeColor(canvas, accent, 0.6)], [0.8, accent], [1, colors['accent-hover']]]
    : [[0, colors['gold-surface']], [0.18, mixThemeColor(colors['gold-surface'], gold, 0.4)], [0.4, gold], [0.57, mixThemeColor(gold, accent, 0.5)], [0.72, accent], [0.86, colors['accent-pressed']], [1, mixThemeColor(accent, strong, 0.4)]]
  return {
    field,
    sheen: [alpha(dark ? strong : raised, dark ? 0.09 : 0.34), alpha(dark ? canvas : strong, dark ? 0.18 : 0.08)] as const,
    clouds: [accent, colors['accent-text'], mixThemeColor(accent, strong, 0.2)] as const,
    thread: gold,
    threadShadow: mixThemeColor(gold, raised, 0.3),
    particles: [gold, mixThemeColor(gold, strong, 0.4), colors['accent-text'], strong, mixThemeColor(gold, raised, 0.7)] as const,
    waves: [gold, colors['accent-text'], mixThemeColor(gold, strong, 0.24)] as const,
  }
}

export interface ReasoningFieldFrame {
  dark: boolean
  dragging: boolean
  height: number
  momentum: number
  progress: number
  time: number
  width: number
}

export function createReasoningFieldRenderer(waveMaskCanvas: HTMLCanvasElement, getPalette: () => ReturnType<typeof createReasoningFieldPalette>) {
  function drawEnergyField(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    progress: number,
    time: number,
    dark: boolean,
    momentum: number,
    dragging: boolean,
  ) {
    const trackInset = height * 0.34
    const frontX = trackInset + progress * (width - trackInset * 2)
    const intensity = 0.24 + progress * 0.76
    const motion = time * (0.32 + progress * 0.78) * (dragging ? 2.1 : 1)
    const particleBoundary = progress >= 0.999
      ? width
      : frontX + height * (1.08 + Math.max(0, momentum) * 0.2)

    context.save()
    drawBaseField(context, width, height, progress, dark)
    drawNebula(context, width, height, intensity, dark)
    drawThreads(context, width, height, particleBoundary, progress, dark)
    drawParticles(context, width, height, particleBoundary, progress, intensity, motion, dark, dragging)
    if (progress < 0.999)
      drawEnergyWaves(context, width, height, frontX, progress, time, dark, momentum, dragging)
    context.restore()
    maskEnergyField(context, width, height, frontX, progress, time, momentum, dragging)
  }

  function drawBaseField(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    progress: number,
    dark: boolean,
  ) {
    const field = context.createLinearGradient(0, 0, width, 0)
    const palette = getPalette()
    for (const [position, color] of palette.field)
      field.addColorStop(position, color)
    context.globalAlpha = dark
      ? 0.74 + progress * 0.26
      : 0.9 + progress * 0.1
    context.fillStyle = field
    context.fillRect(0, 0, width, height)

    const sheen = context.createLinearGradient(0, 0, 0, height)
    sheen.addColorStop(0, palette.sheen[0])
    sheen.addColorStop(0.38, 'transparent')
    sheen.addColorStop(1, palette.sheen[1])
    context.globalAlpha = 1
    context.fillStyle = sheen
    context.fillRect(0, 0, width, height)
  }

  function drawNebula(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    intensity: number,
    dark: boolean,
  ) {
    context.save()
    context.globalCompositeOperation = dark ? 'screen' : 'source-over'
    const colors = getPalette().clouds
    if (dark) {
      drawCloud(context, width * 0.22, height * 0.64, width * 0.28, height * 0.72, alpha(colors[0], 0.08 + intensity * 0.1))
      drawCloud(context, width * 0.58, height * 0.34, width * 0.32, height * 0.78, alpha(colors[1], 0.08 + intensity * 0.14))
      drawCloud(context, width * 0.86, height * 0.62, width * 0.24, height * 0.7, alpha(colors[2], 0.06 + intensity * 0.12))
    }
    else {
      drawCloud(context, width * 0.13, height * 0.36, width * 0.24, height * 0.72, alpha(colors[0], 0.1 + intensity * 0.1))
      drawCloud(context, width * 0.4, height * 0.7, width * 0.27, height * 0.74, alpha(colors[1], 0.1 + intensity * 0.12))
      drawCloud(context, width * 0.76, height * 0.34, width * 0.28, height * 0.76, alpha(colors[2], 0.06 + intensity * 0.11))
    }
    context.restore()
  }

  function drawThreads(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    boundary: number,
    progress: number,
    dark: boolean,
  ) {
    const visibility = clamp((progress - 0.18) / 0.82, 0, 1)
    if (visibility <= 0)
      return

    context.save()
    context.lineCap = 'round'
    context.lineWidth = 0.38
    context.strokeStyle = getPalette().thread
    context.shadowBlur = progress * 1.8
    context.shadowColor = getPalette().threadShadow
    for (const thread of threads) {
      if (thread.threshold > visibility)
        continue
      const x1 = thread.x1 * width
      const x2 = thread.x2 * width
      if (x2 > boundary)
        continue
      const y1 = thread.y1 * height
      const y2 = thread.y2 * height
      context.beginPath()
      context.moveTo(x1, y1)
      context.quadraticCurveTo(
        (x1 + x2) / 2,
        (y1 + y2) / 2 + thread.bend * height,
        x2,
        y2,
      )
      context.globalAlpha = (dark ? 0.07 : 0.045) + progress * (dark ? 0.09 : 0.055)
      context.stroke()
    }
    context.restore()
  }

  function drawParticles(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    boundary: number,
    progress: number,
    intensity: number,
    motion: number,
    dark: boolean,
    dragging: boolean,
  ) {
    const density = 0.38 + progress * 0.62
    const palette = getPalette().particles

    context.save()
    context.globalCompositeOperation = dark ? 'lighter' : 'source-over'
    for (const [index, particle] of particles.entries()) {
      if (particle.threshold > density)
        continue
      const normalizedX = (particle.x + motion * particle.speed * 0.0035) % 1
      const x = normalizedX * width
      if (x > boundary)
        continue
      const y = (particle.y + Math.sin(motion * particle.speed + particle.phase) * 0.025) * height
      const shimmer = 0.72 + Math.sin(motion * 1.8 + particle.phase) * 0.28
      const size = particle.size * (0.72 + progress * 0.38) * (dragging ? 1.08 : 1)
      const color = palette[Math.min(palette.length - 1, Math.floor(particle.tone * palette.length))] ?? palette[0]

      context.beginPath()
      context.arc(x, y, size, 0, Math.PI * 2)
      context.fillStyle = color
      context.globalAlpha = (dark
        ? 0.2 + intensity * 0.48
        : 0.27 + intensity * 0.4) * shimmer
      context.shadowBlur = 1.5 + size * (2.5 + progress * 3.5)
      context.shadowColor = color
      context.fill()

      if (index % 19 !== 0 || size < 0.58)
        continue
      context.beginPath()
      context.moveTo(x - size * 2.4, y)
      context.lineTo(x + size * 2.4, y)
      context.moveTo(x, y - size * 2.4)
      context.lineTo(x, y + size * 2.4)
      context.globalAlpha *= 0.38
      context.lineWidth = 0.42
      context.strokeStyle = color
      context.stroke()
    }
    context.restore()
  }

  function maskEnergyField(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    frontX: number,
    progress: number,
    time: number,
    momentum: number,
    dragging: boolean,
  ) {
    if (progress >= 0.999)
      return

    const maskCanvas = getWaveMaskCanvas(width, height)
    const maskContext = maskCanvas.getContext('2d')
    if (!maskContext)
      return
    maskContext.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
    for (let y = 0; y < Math.ceil(height); y += 1) {
      const normalizedY = y / height
      const boundary = frontX - height * 0.08 + waveBoundaryOffset(normalizedY, height, time, momentum)
      const coreEnd = Math.max(0, boundary - height * 0.12)
      const forwardStretch = Math.max(0, momentum) * 0.2
      const featherEnd = Math.min(
        width,
        boundary + height * (0.62 + forwardStretch + (dragging ? 0.08 : 0)),
      )
      maskContext.fillStyle = 'white'
      maskContext.fillRect(0, y, coreEnd, 1.25)
      if (featherEnd <= coreEnd)
        continue
      const mask = maskContext.createLinearGradient(coreEnd, 0, featherEnd, 0)
      mask.addColorStop(0, 'white')
      mask.addColorStop(0.2, 'rgb(255 255 255 / 95%)')
      mask.addColorStop(0.52, 'rgb(255 255 255 / 38%)')
      mask.addColorStop(0.82, 'rgb(255 255 255 / 9%)')
      mask.addColorStop(1, 'transparent')
      maskContext.fillStyle = mask
      maskContext.fillRect(coreEnd, y, featherEnd - coreEnd, 1.25)
    }

    context.save()
    context.globalCompositeOperation = 'destination-in'
    context.drawImage(maskCanvas, 0, 0, width, height)
    context.restore()
  }

  function getWaveMaskCanvas(width: number, height: number): HTMLCanvasElement {
    const pixelWidth = Math.max(1, Math.ceil(width))
    const pixelHeight = Math.max(1, Math.ceil(height))
    if (waveMaskCanvas.width !== pixelWidth)
      waveMaskCanvas.width = pixelWidth
    if (waveMaskCanvas.height !== pixelHeight)
      waveMaskCanvas.height = pixelHeight
    return waveMaskCanvas
  }

  function drawEnergyWaves(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    frontX: number,
    progress: number,
    time: number,
    dark: boolean,
    momentum: number,
    dragging: boolean,
  ) {
    const stretch = clamp(1 + momentum * 0.28 + (dragging ? 0.1 : 0), 0.72, 1.42)
    const startX = Math.max(0, frontX - height * (1.45 + progress * 0.42))
    const endX = Math.min(width, frontX + height * (0.72 + progress * 0.22) * stretch)
    const span = Math.max(1, endX - startX)
    const amplitude = height * (0.07 + progress * 0.035 + Math.abs(momentum) * 0.025)
    const colors = getPalette().waves

    context.save()
    context.globalCompositeOperation = dark ? 'screen' : 'source-over'
    for (let index = 0; index < 3; index += 1) {
      const phase = index * 2.15 - time * (0.52 + progress * 0.22 + index * 0.06)
      const baseY = height * (0.29 + index * 0.21)
      const layerAmplitude = amplitude * (0.86 + index * 0.12)
      const thickness = height * (0.052 + index * 0.008 + progress * 0.008)
      const points = createWavePoints(startX, span, baseY, layerAmplitude, phase, index)
      const ribbon = context.createLinearGradient(startX, 0, endX, 0)
      const color = colors[index] ?? colors[0]
      ribbon.addColorStop(0, 'transparent')
      ribbon.addColorStop(0.24, alpha(color, dark ? 0.07 : 0.04))
      ribbon.addColorStop(0.58, alpha(color, dark ? 0.24 : 0.15))
      ribbon.addColorStop(0.8, alpha(color, dark ? 0.13 : 0.075))
      ribbon.addColorStop(1, 'transparent')

      context.beginPath()
      context.moveTo(points[0]?.x ?? startX, (points[0]?.y ?? baseY) - thickness)
      for (const point of points)
        context.lineTo(point.x, point.y - thickness)
      for (let pointIndex = points.length - 1; pointIndex >= 0; pointIndex -= 1) {
        const point = points[pointIndex]
        if (point)
          context.lineTo(point.x, point.y + thickness)
      }
      context.closePath()
      context.fillStyle = ribbon
      context.fill()
    }
    context.restore()
  }

  function drawCloud(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    color: string,
  ) {
    context.save()
    context.translate(x, y)
    context.scale(radiusX / radiusY, 1)
    const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radiusY)
    gradient.addColorStop(0, color)
    gradient.addColorStop(1, 'transparent')
    context.fillStyle = gradient
    context.fillRect(-radiusY, -radiusY, radiusY * 2, radiusY * 2)
    context.restore()
  }

  return (context: CanvasRenderingContext2D, frame: ReasoningFieldFrame) => {
    drawEnergyField(context, frame.width, frame.height, frame.progress, frame.time, frame.dark, frame.momentum, frame.dragging)
  }
}
