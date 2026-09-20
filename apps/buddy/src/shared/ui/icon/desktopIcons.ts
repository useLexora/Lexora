import accountAvatarUrl from './assets/account-avatar.svg'
import deleteUrl from './assets/delete.svg'
import messageBranchNextUrl from './assets/message-branch-next.svg'
import messageBranchPreviousUrl from './assets/message-branch-previous.svg'
import messageCopiedUrl from './assets/message-copied.svg'
import messageCopyUrl from './assets/message-copy.svg'
import messageEditUrl from './assets/message-edit.svg'
import messageQueueUrl from './assets/message-queue.svg'
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
import windowCloseUrl from './assets/window-close.svg'
import windowMaximizeUrl from './assets/window-maximize.svg'
import windowMinimizeUrl from './assets/window-minimize.svg'
import windowPinUrl from './assets/window-pin.svg'
import windowRestoreUrl from './assets/window-restore.svg'

export const DESKTOP_ICON_URLS = {
  accountAvatar: accountAvatarUrl,
  delete: deleteUrl,
  messageBranchNext: messageBranchNextUrl,
  messageBranchPrevious: messageBranchPreviousUrl,
  messageCopied: messageCopiedUrl,
  messageCopy: messageCopyUrl,
  messageEdit: messageEditUrl,
  messageQueue: messageQueueUrl,
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
  windowClose: windowCloseUrl,
  windowMaximize: windowMaximizeUrl,
  windowMinimize: windowMinimizeUrl,
  windowPin: windowPinUrl,
  windowRestore: windowRestoreUrl,
} as const

export type DesktopIconName = keyof typeof DESKTOP_ICON_URLS
