export interface DocsChatPanelProps {
  isResizing?: boolean
  maxWidthPx: number
  minWidthPx: number
  widthPx: number
}

export interface DocsChatPanelEmits {
  resizeKeydown: [event: KeyboardEvent]
  resizeReset: []
  resizeStart: [event: PointerEvent]
}
