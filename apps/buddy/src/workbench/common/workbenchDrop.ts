import type { DropPosition } from './workbench'

export function resolveWorkbenchDrop(point: { x: number, y: number }, bounds: { left: number, top: number, width: number, height: number }): DropPosition | null {
  const x = (point.x - bounds.left) / bounds.width
  const y = (point.y - bounds.top) / bounds.height
  if (x < 0 || x > 1 || y < 0 || y > 1 || !Number.isFinite(x + y))
    return null
  if (x > 0.2 && x < 0.8 && y > 0.2 && y < 0.8)
    return 'center'
  const edges = [{ direction: 'left', distance: x }, { direction: 'right', distance: 1 - x }, { direction: 'up', distance: y }, { direction: 'down', distance: 1 - y }] as const
  return edges.reduce((closest, edge) => edge.distance < closest.distance ? edge : closest).direction
}
