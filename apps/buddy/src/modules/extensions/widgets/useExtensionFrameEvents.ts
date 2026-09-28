import type { ViewEnvironment } from '@buddy-shared/extensions/extensionViewEvents'
import type { AnchorGeometry } from '@buddy-shared/workbench/workbenchUi'
import type { ExtensionContext } from '../extensionContext'
import type { ExtensionViewProjection } from './ExtensionViewProjection'
import type { ExtensionSurface } from './useExtensionViews'
import { onScopeDispose, watch } from 'vue'

export interface ExtensionEventFrame {
  readonly surface: ExtensionSurface
  readonly projection: ExtensionViewProjection
  readonly visible: boolean
  readonly geometry: AnchorGeometry | null
}
export function useExtensionFrameEvents(options: {
  context: ExtensionContext
  frames: ReadonlyMap<string, ExtensionEventFrame>
  environment: () => ViewEnvironment
  isOverlay: (surface: ExtensionSurface) => boolean
}) {
  const { context, frames, environment, isOverlay } = options
  const refresh = (frame: ExtensionEventFrame) => {
    frame.projection.publish({ type: 'view:environment:changed', data: { environment: environment() } })
    frame.projection.publish({ type: 'workbench:context:changed', data: { context: context.workbench.value } })
    frame.projection.publish({ type: 'view:visibility:changed', data: { visible: frame.visible && document.visibilityState === 'visible' } })
    const control = frame.surface.control?.snapshot()
    if (control)
      frame.projection.publish({ type: 'control:changed', data: { control } })
  }
  watch([context.language, context.isDark, context.workbench], () => {
    for (const frame of frames.values()) refresh(frame)
  }, { flush: 'post' })
  watch(() => [...context.views.surfaces.values()].map(surface => surface.control?.snapshot()), () => {
    for (const frame of frames.values()) refresh(frame)
  }, { flush: 'post' })
  let lastActivity = 0
  onScopeDispose(context.anchors.onActivity((anchor, activity) => {
    const now = performance.now()
    const windowActivity = anchor.kind === 'composer.input' && now - lastActivity >= 50
    if (windowActivity)
      lastActivity = now
    for (const frame of frames.values()) {
      if (frame.surface.anchor === anchor && frame.geometry?.visible && frame.surface.ready)
        frame.projection.publish({ type: 'composer:input:received', data: { caret: activity.caret } })
      else if (windowActivity && !frame.surface.anchor && isOverlay(frame.surface) && frame.visible && frame.surface.ready)
        frame.projection.publish({ type: 'composer:input:received', data: {} })
    }
  }))
  onScopeDispose(context.views.onMessage((extensionId, generation, message) => {
    for (const frame of frames.values()) {
      if (frame.surface.session?.extensionId === extensionId && frame.surface.session.generation === generation)
        frame.projection.publish({ type: 'view:message:received', data: { message } })
    }
  }))
  return { refresh }
}
