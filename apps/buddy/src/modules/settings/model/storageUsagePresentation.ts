import type { StorageUsage, StorageUsageCategoryId, StorageUsageDetailId } from '@buddy-shared/storage/storageApi'

const categoryLabels = {
  data: ['任务与文件', 'Tasks and files', '--buddy-accent-solid'],
  browser: ['浏览器', 'Browser', '--buddy-data-blue'],
  plugins: ['插件', 'Plugins', '--buddy-data-violet'],
  skills: ['Skills', 'Skills', '--buddy-data-cyan'],
  device: ['应用设置', 'Application settings', '--buddy-text-muted'],
  cache: ['应用缓存', 'Application cache', '--buddy-data-cyan'],
  logs: ['日志与崩溃报告', 'Logs and crash reports', '--buddy-brand-gold'],
  exports: ['备份与恢复', 'Backups and recovery', '--buddy-text-secondary'],
} satisfies Record<StorageUsageCategoryId, [string, string, string]>

const detailLabels = {
  database: ['应用数据库', 'Application database'],
  sessions: ['会话与执行记录', 'Sessions and execution records'],
  attachments: ['附件与媒体', 'Attachments and media'],
  workspace: ['工作区与产物', 'Workspaces and outputs'],
  changes: ['文件变更快照', 'File change snapshots'],
  other: ['其他数据', 'Other data'],
  siteData: ['网站数据', 'Site data'],
  webCache: ['网页缓存', 'Web cache'],
  codeCache: ['代码缓存', 'Code cache'],
  graphicsCache: ['图形缓存', 'Graphics cache'],
  packages: ['插件文件', 'Plugin files'],
  pluginData: ['插件数据', 'Plugin data'],
  configuration: ['安装与配置', 'Installation and configuration'],
  application: ['应用日志', 'Application logs'],
  crashes: ['崩溃报告', 'Crash reports'],
  snapshots: ['本地备份', 'Local backups'],
  recovery: ['恢复副本', 'Recovery copies'],
} satisfies Record<StorageUsageDetailId, [string, string]>

const otherLabels: Partial<Record<StorageUsageCategoryId, [string, string]>> = {
  data: ['其他应用数据', 'Other application data'],
  cache: ['其他缓存', 'Other cache'],
  exports: ['其他备份与导出', 'Other backups and exports'],
}

function detailLabel(category: StorageUsageCategoryId, detail: StorageUsageDetailId, english: boolean): string {
  const labels = detail === 'other' ? otherLabels[category] ?? detailLabels.other : detailLabels[detail]
  return labels[english ? 1 : 0]
}

export function presentStorageUsage(usage: StorageUsage | null, english: boolean) {
  const total = usage?.categories.reduce((sum, category) => sum + category.bytes, 0) ?? 0
  const locale = english ? 'en-US' : 'zh-CN'
  return (usage?.categories ?? []).map((category) => {
    const [zh, en, color] = categoryLabels[category.id]
    const share = total > 0 ? category.bytes / total : 0
    return {
      id: category.id,
      label: english ? en : zh,
      color,
      bytes: category.bytes,
      share: share > 0 && share < 0.001 ? '<0.1%' : share.toLocaleString(locale, { style: 'percent', maximumFractionDigits: 1 }),
      details: category.details
        .filter(detail => detail.files > 0)
        .map(detail => ({
          ...detail,
          label: detailLabel(category.id, detail.id, english),
        }))
        .sort((a, b) => b.bytes - a.bytes),
    }
  }).sort((a, b) => b.bytes - a.bytes)
}

export type StorageUsageCategoryView = ReturnType<typeof presentStorageUsage>[number]
