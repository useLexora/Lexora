import type { StorageOperation } from '../../../shared/storage/storageApi'
import { diagnosticCodeSchema } from '../../../shared/diagnostics/applicationDiagnostic'

export function storageMigrationErrorCode(error: string | null): string {
  const parsed = diagnosticCodeSchema.safeParse(error)
  return parsed.success ? parsed.data : 'STORAGE_MIGRATION_FAILED'
}

export function storageMigrationIssueBody(input: {
  kind: StorageOperation['kind']
  error: string | null
  launchId: string
  operationId: string
  appVersion: string
  platform: string
}): string {
  const kind = { consolidate: '首次升级整理', relocate: '更改数据目录', restore: '恢复备份' }[input.kind]
  return [
    '## 问题描述',
    `Lexora 在${kind}时未能完成。`,
    '',
    '## 诊断信息',
    `- 版本：${input.appVersion}`,
    `- 平台：${input.platform}`,
    `- 错误码：${storageMigrationErrorCode(input.error)}`,
    `- 诊断编号：${input.launchId}`,
    `- 操作编号：${input.operationId}`,
    '',
    '## 补充信息',
    '请补充出错前的操作，并在检查后手动附上导出的诊断日志。',
  ].join('\n')
}
