import type { BrowserErrorCode, BrowserRecoveryAction } from '../../../shared/browser'
import type { DesktopBrowserState } from '../../../shared/browser/browserDesktopApi'
import { browserStateSnapshotSchema } from '../../../shared/browser'
import { redactBrowserRuntimeUrl } from './browserPrivacy'

export function projectBrowserState(state: DesktopBrowserState) {
  return browserStateSnapshotSchema.parse({
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    controller: state.controller,
    controlEpoch: state.controlEpoch,
    conversationId: state.conversationId,
    pageId: state.pageId,
    security: state.security,
    sessionId: state.sessionId,
    status: state.status,
    title: state.title,
    visible: state.visible,
    error: state.error
      ? {
          code: state.error.code,
          reason: state.error.reason ?? null,
          recovery: browserRecovery(
            state.error.code,
            'read_again',
          ),
        }
      : null,
    profileMode: state.profileMode,
    url: redactBrowserRuntimeUrl(state.url),
  })
}

export function browserRecovery(
  code: BrowserErrorCode,
  fallback: BrowserRecoveryAction | null,
): BrowserRecoveryAction | null {
  switch (code) {
    case 'BROWSER_CONTROL_REQUIRED':
    case 'BROWSER_DIALOG_PENDING':
    case 'BROWSER_HUMAN_INPUT_REQUIRED':
      return 'request_human_control'
    case 'BROWSER_PAGE_CRASHED':
    case 'BROWSER_SESSION_EVICTED':
    case 'BROWSER_SESSION_NOT_FOUND':
      return 'open_again'
    case 'BROWSER_IN_USE':
    case 'BROWSER_PAGE_UNRESPONSIVE':
    case 'BROWSER_TARGET_STALE':
      return 'read_again'
    case 'BROWSER_NAVIGATION_BLOCKED':
      return null
    case 'BROWSER_PAGE_FAILED':
      return fallback
    default:
      return null
  }
}
