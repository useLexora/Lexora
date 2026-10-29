import accountAvatarUrl from './assets/account-avatar.svg'
import browserPickElementUrl from './assets/browser-pick-element.svg'
import contextPanelActiveUrl from './assets/context-panel-active.svg'
import contextPanelUrl from './assets/context-panel.svg'
import deleteUrl from './assets/delete.svg'
import editFilledUrl from './assets/edit-filled.svg'
import editUrl from './assets/edit.svg'
import messageBranchNextUrl from './assets/message-branch-next.svg'
import messageBranchPreviousUrl from './assets/message-branch-previous.svg'
import messageBranchUrl from './assets/message-branch.svg'
import messageCopiedUrl from './assets/message-copied.svg'
import messageCopyUrl from './assets/message-copy.svg'
import messagePlaybackStopUrl from './assets/message-playback-stop.svg'
import messageQueueUrl from './assets/message-queue.svg'
import messageReadAloudUnavailableUrl from './assets/message-read-aloud-unavailable.svg'
import messageReadAloudUrl from './assets/message-read-aloud.svg'
import messageRetryUrl from './assets/message-retry.svg'
import navigationAutomationUrl from './assets/navigation-automation.svg'
import navigationSettingsUrl from './assets/navigation-settings.svg'
import navigationTaskUrl from './assets/navigation-task.svg'
import notificationMarkAllReadUrl from './assets/notification-mark-all-read.svg'
import pinOffUrl from './assets/pin-off.svg'
import sidebarChevronUrl from './assets/sidebar-chevron.svg'
import spaceNoneUrl from './assets/space-none.svg'
import toolCreateFileUrl from './assets/tool-create-file.svg'
import toolEditFileUrl from './assets/tool-edit-file.svg'
import toolSearchUrl from './assets/tool-search.svg'
import toolUseUrl from './assets/tool-use.svg'
import windowCloseUrl from './assets/window-close.svg'
import windowMaximizeUrl from './assets/window-maximize.svg'
import windowMinimizeUrl from './assets/window-minimize.svg'
import windowPinUrl from './assets/window-pin.svg'
import windowRestoreUrl from './assets/window-restore.svg'

export const DESKTOP_ICON_URLS = {
  accountAvatar: accountAvatarUrl,
  browserPickElement: browserPickElementUrl,
  contextPanel: contextPanelUrl,
  contextPanelActive: contextPanelActiveUrl,
  delete: deleteUrl,
  edit: editUrl,
  editFilled: editFilledUrl,
  messageBranch: messageBranchUrl,
  messageBranchNext: messageBranchNextUrl,
  messageBranchPrevious: messageBranchPreviousUrl,
  messageCopied: messageCopiedUrl,
  messageCopy: messageCopyUrl,
  messagePlaybackStop: messagePlaybackStopUrl,
  messageQueue: messageQueueUrl,
  messageReadAloud: messageReadAloudUrl,
  messageReadAloudUnavailable: messageReadAloudUnavailableUrl,
  messageRetry: messageRetryUrl,
  navigationAutomation: navigationAutomationUrl,
  navigationSettings: navigationSettingsUrl,
  navigationTask: navigationTaskUrl,
  notificationMarkAllRead: notificationMarkAllReadUrl,
  pinOff: pinOffUrl,
  sidebarChevron: sidebarChevronUrl,
  spaceNone: spaceNoneUrl,
  toolCreateFile: toolCreateFileUrl,
  toolEditFile: toolEditFileUrl,
  toolSearch: toolSearchUrl,
  toolUse: toolUseUrl,
  windowClose: windowCloseUrl,
  windowMaximize: windowMaximizeUrl,
  windowMinimize: windowMinimizeUrl,
  windowPin: windowPinUrl,
  windowRestore: windowRestoreUrl,
} as const

export type DesktopIconName = keyof typeof DESKTOP_ICON_URLS
