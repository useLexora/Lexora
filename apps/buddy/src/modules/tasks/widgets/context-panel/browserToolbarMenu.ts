import type { DesktopBrowserProfileMode } from '@buddy-electron/shared/desktopApi'
import type { BuddyI18nKey } from '@/i18n/buddyI18n'

export type BrowserToolbarBusyAction = 'external' | 'folder' | 'profile' | 'screenshot' | 'zoom'

export type BrowserToolbarMenuActionKey
  = | 'capture-screenshot'
    | 'enter-incognito'
    | 'exit-incognito'
    | 'open-external'
    | 'show-file-in-folder'

export interface BrowserToolbarMenuAction {
  disabled: boolean
  key: BrowserToolbarMenuActionKey
  labelKey: BuddyI18nKey
}

interface BrowserToolbarMenuContext {
  busyAction: BrowserToolbarBusyAction | null
  controller: 'agent' | 'human'
  profileMode: DesktopBrowserProfileMode
  url: string
}

export function getBrowserToolbarMenuActions(
  context: BrowserToolbarMenuContext,
): BrowserToolbarMenuAction[] {
  const isBusy = context.busyAction !== null
  const hasPage = context.url !== 'about:blank'
  const actions: BrowserToolbarMenuAction[] = [{
    disabled: isBusy || context.controller === 'agent',
    key: context.profileMode === 'incognito' ? 'exit-incognito' : 'enter-incognito',
    labelKey: context.profileMode === 'incognito'
      ? 'desktop.context.browserExitIncognito'
      : 'desktop.context.browserEnterIncognito',
  }, {
    disabled: isBusy || !hasPage,
    key: 'open-external',
    labelKey: 'desktop.context.browserOpenExternal',
  }, {
    disabled: isBusy || !hasPage,
    key: 'capture-screenshot',
    labelKey: 'desktop.context.browserCaptureScreenshot',
  }]

  if (context.url.startsWith('file:')) {
    actions.push({
      disabled: isBusy,
      key: 'show-file-in-folder',
      labelKey: 'desktop.context.browserShowFileInFolder',
    })
  }
  return actions
}
