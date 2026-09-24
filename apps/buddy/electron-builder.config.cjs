const { resolve } = require('node:path')
const process = require('node:process')
const { desktopArtifactName } = require('../../packaging/buddy/release/artifacts.mjs')
const { macosSigningMode } = require('../../packaging/buddy/release/macos.mjs')
const { nativeHostResources } = require('../../packaging/buddy/release/native-host.mjs')
const { excludedDependencyFiles, platformResources } = require('../../packaging/buddy/release/platform-definition.mjs')
const { resolveBuildTarget } = require('../../packaging/buddy/release/targets.mjs')
const { OPERATING_SYSTEM } = require('./shared/platform/identifiers.ts')

const target = resolveBuildTarget()
const resources = platformResources(target)
const { sourceDateEpoch } = require('./buddy.version.json')
const { desktopName, productName: displayName } = require('./package.json')

process.env.SOURCE_DATE_EPOCH ??= String(sourceDateEpoch)

if (target.platform === OPERATING_SYSTEM.Windows) {
  const helper = nativeHostResources(target).find(resource => resource.name === 'processControl')
  if (!helper)
    throw new Error(`Missing installer process helper: ${target.id}`)
  process.env.LEXORA_INSTALLER_PROCESS_HELPER = resolve(__dirname, helper.from)
}

const macro = name => `$${`{${name}}`}`
const signedMacos = macosSigningMode() === 'developer-id'

module.exports = {
  appId: desktopName,
  productName: 'lexora-buddy',
  asar: true,
  asarUnpack: ['node_modules/@anthropic-ai/sandbox-runtime/vendor/**'],
  electronFuses: {
    enableCookieEncryption: true,
    enableNodeCliInspectArguments: false,
    enableNodeOptionsEnvironmentVariable: false,
    onlyLoadAppFromAsar: true,
    runAsNode: false,
  },
  npmRebuild: false,
  forceCodeSigning: target.platform === OPERATING_SYSTEM.MacOS && signedMacos,
  directories: {
    output: '.output/package/desktop',
  },
  files: [
    '.output/build/electron/**/*',
    'package.json',
    'resources/icons/app-icon.png',
    '!**/__tests__/**',
    '!node_modules/**/*.map',
    ...excludedDependencyFiles(target),
  ],
  mac: {
    extraResources: (target.platform === OPERATING_SYSTEM.MacOS ? resources : []),
    target: [{ target: 'dmg', arch: ['arm64'] }],
    category: 'public.app-category.productivity',
    minimumSystemVersion: target.minimumSystemVersion,
    icon: 'resources/icons/app-icon.png',
    identity: signedMacos ? undefined : '-',
    hardenedRuntime: signedMacos,
    notarize: signedMacos,
    entitlements: '../../packaging/buddy/macos/entitlements.plist',
    entitlementsInherit: '../../packaging/buddy/macos/entitlements.plist',
    binaries: (target.platform === OPERATING_SYSTEM.MacOS ? resources : [])
      .filter(resource => resource.to.startsWith('native-'))
      .map(resource => `Contents/Resources/${resource.to}`)
      .concat(['Contents/Resources/search-tools/fd', 'Contents/Resources/search-tools/rg']),
  },
  dmg: {
    sign: signedMacos,
  },
  win: {
    extraResources: (target.platform === OPERATING_SYSTEM.Windows ? resources : []),
    executableName: displayName,
    icon: 'resources/icons/app-icon.png',
    target: [{ target: 'nsis', arch: [target.architecture] }],
  },
  nsis: {
    include: '../../packaging/buddy/windows/installer.nsh',
    oneClick: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: false,
    perMachine: false,
    runAfterFinish: true,
    shortcutName: displayName,
    uninstallDisplayName: displayName,
    deleteAppDataOnUninstall: false,
  },
  linux: {
    extraResources: (target.platform === OPERATING_SYSTEM.Linux ? resources : []),
    category: 'Utility',
    desktop: {
      entry: {
        Name: displayName,
      },
    },
    executableName: 'lexora-buddy',
    icon: 'resources/icons/app-icon.png',
    synopsis: 'Lexora Buddy local personal AI companion and native desktop pet',
    syncDesktopName: true,
    target: ['deb'],
  },
  deb: {
    appArmorProfile: '../../packaging/buddy/linux/apparmor-profile.tpl',
    packageName: 'lexora-buddy',
    depends: [
      'libcap2',
      'socat',
      'git',
      'libgtk-3-0',
      'libnotify4',
      'libnss3',
      'libxss1',
      'libxtst6',
      'xdg-utils',
      'libatspi2.0-0',
      'libuuid1',
      'libsecret-1-0',
      'libgtk-layer-shell0',
      'webp-pixbuf-loader',
    ],
  },
  pacman: {
    appArmorProfile: '../../packaging/buddy/linux/apparmor-profile.tpl',
    artifactName: `Lexora-Buddy-${macro('version')}-arch-x86_64.pkg.tar.zst`,
    compression: 'zstd',
    packageName: 'lexora-buddy',
    depends: [
      'alsa-lib',
      'at-spi2-core',
      'cairo',
      'dbus',
      'desktop-file-utils',
      'expat',
      'gcc-libs',
      'glib2',
      'glibc',
      'git',
      'gtk-layer-shell',
      'gtk3',
      'hicolor-icon-theme',
      'libcups',
      'libcap',
      'libnotify',
      'libsecret',
      'libx11',
      'libxcb',
      'libxcomposite',
      'libxdamage',
      'libxext',
      'libxfixes',
      'libxkbcommon',
      'libxrandr',
      'libxss',
      'libxtst',
      'mesa',
      'nspr',
      'nss',
      'pango',
      'socat',
      'systemd-libs',
      'util-linux-libs',
      'which',
      'xdg-utils',
    ],
  },
  artifactName: desktopArtifactName(target, target.packageFormats[0], macro('version')),
}
