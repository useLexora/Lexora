import type { BackupScope } from '@buddy-shared/storage/backupScope'

export const backupScopeLabels: Record<BackupScope, { zh: string, en: string, hint: string, hintEn: string }> = {
  tasks: { zh: '任务与空间', en: 'Tasks and spaces', hint: '任务记录、附件、产物与空间信息', hintEn: 'History, attachments, artifacts and space metadata' },
  workspaces: { zh: '托管工作文件', en: 'Managed workspace files', hint: 'Lexora 数据目录内的工作文件，不含外部目录', hintEn: 'Workspace files inside the data directory, excluding external folders' },
  buddies: { zh: '伙伴与 NPC', en: 'Buddies and NPCs', hint: '自定义伙伴、指令、头像及能力偏好', hintEn: 'Custom buddies, instructions, avatars and preferences' },
  providers: { zh: '模型服务配置', en: 'Model services', hint: '服务商、模型与参数；密钥单独选择', hintEn: 'Providers, models and parameters; credentials are optional' },
  connections: { zh: '工具与连接配置', en: 'Tools and connections', hint: 'MCP、搜索服务及云备份连接', hintEn: 'MCP, search services and cloud backup connections' },
  skills: { zh: 'Skills', en: 'Skills', hint: '全局与空间 Skills 的文件和安装信息', hintEn: 'Global and space skill files and installation records' },
  plugins: { zh: '插件与插件数据', en: 'Plugins and plugin data', hint: '安装包、插件设置、保存的数据及定时任务', hintEn: 'Packages, settings, saved data and schedules' },
  automations: { zh: '自动化', en: 'Automations', hint: '自动化定义与计划，恢复后暂停', hintEn: 'Automation definitions and schedules, paused after restore' },
  settings: { zh: '应用设置', en: 'Application settings', hint: '外观、快捷键、通知、桌宠与使用偏好', hintEn: 'Appearance, shortcuts, notifications, pet and preferences' },
}
