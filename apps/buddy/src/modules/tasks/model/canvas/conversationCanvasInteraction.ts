export const CANVAS_INTERACTION_IDLE_MS = 160
export const CANVAS_SIMPLIFIED_ENTER_SCALE = 0.55
export const CANVAS_SIMPLIFIED_EXIT_SCALE = 0.65

export function resolveCanvasSimplifiedMode(simplified: boolean, scale: number) {
  return simplified ? scale <= CANVAS_SIMPLIFIED_EXIT_SCALE : scale < CANVAS_SIMPLIFIED_ENTER_SCALE
}

export function createCanvasInteraction(options: {
  onStart: () => void
  onEnd: () => void
}) {
  let active = false
  let held = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function clearTimer() {
    clearTimeout(timer)
    timer = undefined
  }

  function finish(notify = true) {
    clearTimer()
    held = false
    if (!active)
      return
    active = false
    if (notify)
      options.onEnd()
  }

  function touch() {
    clearTimer()
    if (!active) {
      active = true
      options.onStart()
    }
    if (!held)
      timer = setTimeout(finish, CANVAS_INTERACTION_IDLE_MS)
  }

  return {
    get active() { return active },
    touch,
    hold() {
      held = true
      touch()
    },
    release() {
      if (!held)
        return
      held = false
      touch()
    },
    finish: () => finish(),
    dispose: () => finish(false),
  }
}
