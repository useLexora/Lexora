export function extensionTaskCleanupLabels(language: string) {
  const english = language === 'en-US'
  return {
    title: english ? 'Clean up legacy tasks' : '清理旧版任务',
    plugin: english ? 'Plugin' : '插件',
    scope: english ? 'legacy removed tasks' : '个旧版已移除任务',
    irreversible: english ? 'Deletion is permanent' : '删除后无法恢复',
    risk: english ? 'This deletes their local history and host-managed data. Active and archived tasks, user workspaces and external files are not affected.' : '将删除这些任务的本地历史和宿主管理的数据。不处理活动或已归档任务，不影响用户工作区及外部文件。',
    changed: english ? 'Tasks changed after this check will not be deleted without a new check.' : '检查后状态发生变化的任务将拒绝清理。',
    cancel: english ? 'Cancel' : '取消',
    delete: english ? 'Delete' : '删除',
    skipped: (count: number) => english ? `${count} tasks are not currently eligible and were excluded.` : `${count} 项暂不可清理，本次未包含。`,
    responseFailed: english ? 'The confirmation could not be updated. Please try again.' : '未能更新确认信息，请重试。',
    expired: english ? 'This confirmation has expired. Check again before deleting.' : '本次确认已失效，请重新检查后再删除。',
  }
}
