export interface SurfaceRect {
  x: number
  y: number
  width: number
  height: number
}

export interface SurfaceLayoutGeometry {
  visible: boolean
  bounds: SurfaceRect
  clip: SurfaceRect
}

const emptyRect = { x: 0, y: 0, width: 0, height: 0 }
export const hiddenSurfaceGeometry: SurfaceLayoutGeometry = { visible: false, bounds: emptyRect, clip: emptyRect }

export interface SurfaceLayoutOptions {
  anchor: HTMLElement | null
  visible: boolean
  interactive: boolean
  childrenOnly?: boolean
  retainSizeWhenHidden?: boolean
  layer: 'content' | 'decoration'
  onLayout?: (geometry: SurfaceLayoutGeometry) => void
}

export interface SurfaceLayoutLease {
  update: (options: SurfaceLayoutOptions) => void
  dispose: () => void
}

export interface SurfaceLayout {
  attach: (element: HTMLElement, options: SurfaceLayoutOptions) => SurfaceLayoutLease
  invalidate: () => void
}
