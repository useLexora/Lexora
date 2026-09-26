export interface SurfaceLayoutOptions {
  anchor: HTMLElement | null
  visible: boolean
  interactive: boolean
  childrenOnly?: boolean
  layer: 'content' | 'decoration'
  onLayout?: (geometry: { visible: boolean, width: number, height: number }) => void
}

export interface SurfaceLayoutLease {
  update: (options: SurfaceLayoutOptions) => void
  dispose: () => void
}

export interface SurfaceLayout {
  attach: (element: HTMLElement, options: SurfaceLayoutOptions) => SurfaceLayoutLease
  invalidate: () => void
}
