import type { NativeImage } from 'electron'
import type { BuddyRuntimeProfile } from '../../shared/runtime/profile'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { nativeImage } from 'electron'
import developmentTray from '../../resources/icons/macos/tray-icon-dev.png?asset'
import developmentTray2x from '../../resources/icons/macos/tray-icon-dev@2x.png?asset'
import testTray from '../../resources/icons/macos/tray-icon-test.png?asset'
import testTray2x from '../../resources/icons/macos/tray-icon-test@2x.png?asset'
import stableTray from '../../resources/icons/macos/tray-icon.png?asset'
import stableTray2x from '../../resources/icons/macos/tray-icon@2x.png?asset'

const macosTrayIcons: Record<BuddyRuntimeProfile, readonly [string, string]> = {
  stable: [stableTray, stableTray2x],
  development: [developmentTray, developmentTray2x],
  test: [testTray, testTray2x],
}

export function createDesktopTrayImage(iconPath: string, profile: BuddyRuntimeProfile): NativeImage {
  if (process.platform !== 'darwin')
    return nativeImage.createFromPath(iconPath)

  const image = nativeImage.createEmpty()
  for (const [index, path] of macosTrayIcons[profile].entries()) {
    image.addRepresentation({
      scaleFactor: index + 1,
      dataURL: `data:image/png;base64,${readFileSync(path).toString('base64')}`,
    })
  }
  return image
}
