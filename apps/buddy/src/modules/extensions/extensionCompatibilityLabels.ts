import type { ExtensionCompatibilityIssue } from '@buddy-shared/extensions/extensionCompatibility'

export function extensionCompatibilityLabel(issue: ExtensionCompatibilityIssue, language: string): string {
  const en = language === 'en-US'
  switch (issue.reason) {
    case 'app-too-old':
    case 'api-unsupported':
    case 'format-unsupported': return en ? 'This plugin needs a newer Lexora version.' : '此插件需要新版 Lexora。'
    case 'app-too-new': return en ? 'This plugin has not been updated for your Lexora app yet. Please wait for a plugin update.' : '此插件尚未适配当前 Lexora 版本，请等待插件更新。'
    case 'app-version-unsupported': return en ? 'This plugin does not support your Lexora app version. Please contact its author.' : '此插件不支持当前应用版本，请联系插件作者。'
    case 'manifest-invalid': return en ? 'This plugin has invalid package information. Please contact its author.' : '此插件的包信息无效，请联系插件作者修复。'
  }
}
