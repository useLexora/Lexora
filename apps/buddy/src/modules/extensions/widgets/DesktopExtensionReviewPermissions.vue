<script setup lang="ts">
import type { ExtensionReview } from '@buddy-shared/extensions/extensionApi'
import type { Component } from 'vue'
import { Alert20Regular, Clipboard20Regular, Clock20Regular, Document20Regular, Folder20Regular, Globe20Regular, Link20Regular, Settings20Regular, Sparkle20Regular, Warning20Regular } from '@vicons/fluent'
import { computed } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { extensionLabels } from '../extensionLabels'

interface ReviewOperation {
  key: string
  label: string
  permissions: string[]
}

interface ReviewResource {
  key: string
  title: string
  icon: Component
  operations: ReviewOperation[]
  scope: string
}

const props = defineProps<{ review: ExtensionReview, language: string }>()
const english = computed(() => props.language === 'en-US')
const labels = computed(() => extensionLabels(props.language))
const resources = computed<ReviewResource[]>(() => {
  const p = props.review.manifest.permissions
  const fileRead = [
    ...(p.selectedResource === 'read' ? ['selectedResource:read'] : []),
    ...(p.localResources ? ['localResources'] : []),
    ...(p.fileEditing ? ['fileEditing'] : []),
  ]
  const fileScope: string[] = []
  if (fileRead.length)
    fileScope.push(english.value ? 'Only files you give this plugin.' : '仅访问你交给此插件的文件。')
  if (p.localResources)
    fileScope.push(english.value ? 'Access to files picked in a system dialog remains until revoked.' : '系统窗口选中的文件授权保留至撤销。')
  if (p.fileEditing)
    fileScope.push(english.value ? 'Can edit and save files you open with this plugin. Reading alone does not grant write access.' : '可编辑并保存你用此插件打开的文件；单独读取不会获得写回权限。')
  if (p.resourceExport)
    fileScope.push(english.value ? 'You choose each Save As destination; reading does not grant overwrite access.' : '另存为时由你选择位置；读取不授予覆写权限。')

  return [
    {
      key: 'clipboard',
      title: english.value ? 'Clipboard' : '剪贴板',
      icon: Clipboard20Regular,
      operations: [
        { key: 'read', label: english.value ? 'Read' : '读取', permissions: p.clipboardRead ? ['clipboardRead'] : [] },
        { key: 'write', label: english.value ? 'Write' : '写入', permissions: p.clipboardWrite ? ['clipboardWrite'] : [] },
      ],
      scope: english.value
        ? `Text and HTML only while the plugin view is visible and focused.${p.clipboardRead ? ' Reads do not require individual confirmation.' : ''}`
        : `仅插件页面在前台可见并聚焦时访问文本和 HTML。${p.clipboardRead ? '读取不再逐次确认。' : ''}`,
    },
    {
      key: 'files',
      title: english.value ? 'Files' : '文件',
      icon: Document20Regular,
      operations: [
        { key: 'read', label: english.value ? 'Read' : '读取', permissions: fileRead },
        { key: 'save', label: english.value ? 'Save As' : '另存为', permissions: [...(p.resourceExport ? ['resourceExport'] : []), ...(p.fileEditing ? ['fileEditing'] : [])] },
        { key: 'edit', label: english.value ? 'Edit originals' : '编辑原件', permissions: p.fileEditing ? ['fileEditing'] : [] },
      ],
      scope: fileScope.join(english.value ? ' ' : ''),
    },
    {
      key: 'directories',
      title: english.value ? 'Folders' : '目录',
      icon: Folder20Regular,
      operations: [{ key: 'read', label: english.value ? 'Read' : '读取', permissions: p.localResources ? ['localResources'] : [] }],
      scope: english.value ? 'Read and scan only folders you select and their files. Access remains until revoked.' : '仅读取、扫描你选择的目录及其中的文件，授权保留至撤销。',
    },
    {
      key: 'references',
      title: english.value ? 'References' : '对话引用',
      icon: Link20Regular,
      operations: [
        { key: 'add', label: english.value ? 'Add' : '添加', permissions: p.references ? ['references'] : [] },
        { key: 'read', label: english.value ? 'Read' : '读取', permissions: p.references ? ['references'] : [] },
      ],
      scope: english.value ? 'Add to a draft you choose and read sent references from this plugin only. No message sending or additional file access.' : '添加到你选择的草稿，仅读取已发送的本插件引用；不发送消息或扩大文件权限。',
    },
    {
      key: 'agent',
      title: english.value ? 'Task tools' : '任务工具',
      icon: Sparkle20Regular,
      operations: [{ key: 'run', label: english.value ? 'Run tools and actions' : '运行工具与动作', permissions: p.agent ? ['agent'] : [] }],
      scope: english.value ? 'Models may call tools; actions run on declared task events or your request.' : '模型可调用工具；动作可由声明的任务事件或你的主动请求触发。',
    },
    {
      key: 'task',
      title: english.value ? 'Invoking task' : '当前任务',
      icon: Document20Regular,
      operations: [
        { key: 'title-read', label: english.value ? 'Read title' : '读取标题', permissions: p.tasks !== 'none' ? ['tasks:read'] : [] },
        { key: 'title-write', label: english.value ? 'Update title' : '修改标题', permissions: p.tasks === 'title' ? ['tasks:title'] : [] },
        { key: 'messages', label: english.value ? 'Read messages' : '读取消息', permissions: p.taskMessages ? ['taskMessages'] : [] },
      ],
      scope: [
        english.value ? 'Only the task that invokes the plugin.' : '仅触发调用的任务。',
        ...(p.tasks === 'title' ? [english.value ? 'Protected titles change only on your explicit action.' : '受保护的标题仅在你主动操作时替换。'] : []),
        ...(p.taskMessages ? [english.value ? 'Limited message text, excluding attachments and tool output.' : '消息仅限文本摘录，不含附件内容和工具输出。'] : []),
      ].join(english.value ? ' ' : ''),
    },
    {
      key: 'selectedContent',
      title: english.value ? 'Selected content' : '选中内容',
      icon: Document20Regular,
      operations: [{ key: 'read', label: english.value ? 'Read' : '读取', permissions: p.selectedContent ? ['selectedContent'] : [] }],
      scope: english.value ? 'Receive the current draft or message only when you invoke its action.' : '仅在你主动调用操作时获取当前草稿或该条消息。',
    },
    {
      key: 'models',
      title: english.value ? 'Models' : '模型',
      icon: Sparkle20Regular,
      operations: [{ key: 'call', label: english.value ? 'Call' : '调用', permissions: p.models ? ['models'] : [] }],
      scope: english.value ? 'Send tool-provided text to configured models; usage may incur costs. Credentials stay in Lexora.' : '将工具文本发送至已配置的模型，可能产生费用；凭据不交给插件。',
    },
    {
      key: 'shells',
      title: english.value ? 'Interpreters' : '命令解释器',
      icon: Settings20Regular,
      operations: [{ key: 'detect', label: english.value ? 'Detect' : '检测', permissions: p.shells ? ['shells'] : [] }],
      scope: english.value ? 'Read local paths and versions. Only candidates you enable become model choices; the plugin cannot execute commands or change paths.' : '读取本机路径和版本，仅你启用的候选可供模型选择；插件不能执行命令或修改路径。',
    },
    {
      key: 'windowEffects',
      title: english.value ? 'Window appearance' : '窗口外观',
      icon: Settings20Regular,
      operations: [{ key: 'customize', label: english.value ? 'Customize' : '自定义', permissions: p.windowEffects ? ['windowEffects'] : [] }],
      scope: english.value ? 'Inject CSS, draw effects and receive typing activity, never typed text or keys.' : '注入 CSS、绘制效果和接收输入活动；不获取输入文字或按键。',
    },
    {
      key: 'controls',
      title: english.value ? 'Controls' : '界面控件',
      icon: Settings20Regular,
      operations: [{ key: 'provide', label: english.value ? 'Submit choices' : '提交选择', permissions: p.controls.map(target => `controls:${target}`) }],
      scope: english.value ? 'Only through controls you enable.' : '仅在你启用控件后，通过它提交你的选择。',
    },
    {
      key: 'notifications',
      title: english.value ? 'Notifications' : '系统通知',
      icon: Alert20Regular,
      operations: [{ key: 'send', label: english.value ? 'Send' : '发送', permissions: p.notifications ? ['notifications'] : [] }],
      scope: '',
    },
    {
      key: 'schedules',
      title: english.value ? 'Background tasks' : '后台任务',
      icon: Clock20Regular,
      operations: [{ key: 'run', label: english.value ? 'Run on a schedule' : '定时运行', permissions: p.schedules ? ['schedules'] : [] }],
      scope: english.value ? 'While Lexora is running, even when the plugin page is closed.' : 'Lexora 运行期间，即使关闭插件页面仍可执行。',
    },
    {
      key: 'themeManagement',
      title: english.value ? 'Themes' : '主题',
      icon: Settings20Regular,
      operations: [{ key: 'manage', label: english.value ? 'Manage' : '管理', permissions: p.themeManagement ? ['themeManagement'] : [] }],
      scope: english.value ? 'Save, preview and select themes. Package themes remain read-only.' : '保存、预览和切换主题；插件包内主题只读。',
    },
    {
      key: 'network',
      title: english.value ? 'Network' : '网络',
      icon: Globe20Regular,
      operations: p.network.map(origin => ({ key: origin, label: origin, permissions: [`network:${origin}`] })),
      scope: english.value ? 'Send requests and read responses from these websites, without browser sign-in cookies.' : '向这些网站发送请求并读取响应，不共享浏览器登录状态。',
    },
  ]
    .map(resource => ({ ...resource, operations: resource.operations.filter(operation => operation.permissions.length) }))
    .filter(resource => resource.operations.length)
})
const sharesContent = computed(() => {
  const p = props.review.manifest.permissions
  return (p.clipboardRead || p.selectedResource === 'read' || p.localResources || p.fileEditing || p.selectedContent || p.taskMessages || p.references) && p.network.length > 0
})
function isNewOperation(operation: ReviewOperation): boolean {
  return !!props.review.currentVersion && operation.permissions.some(key => props.review.addedPermissions.includes(key))
}
</script>

<template>
  <section class="extension-review-permissions" data-testid="extension-review-permissions">
    <h3 class="m-0 mb-3 text-[13px] font-semibold leading-[1.6] text-fg">
      {{ english ? 'This plugin can' : '此插件可以' }}
    </h3>
    <dl v-if="resources.length" class="m-0 grid gap-y-3">
      <div v-for="resource in resources" :key="resource.key" class="extension-review-resource grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-1" :data-permission="resource.key">
        <dt class="m-0 flex items-start gap-2 text-[13px] leading-[1.6] text-muted">
          <DesktopIcon class="mt-0.5 shrink-0" :component="resource.icon" :size="16" aria-hidden="true" />
          <span class="[overflow-wrap:anywhere]">{{ resource.title }}</span>
        </dt>
        <dd class="m-0 min-w-0">
          <ul class="m-0 p-0 list-none flex flex-wrap gap-x-4 gap-y-1">
            <li v-for="operation in resource.operations" :key="operation.key" class="flex items-center gap-1.5 text-[13px] leading-[1.6] text-fg [overflow-wrap:anywhere]" :data-operation="operation.key">
              <span>{{ operation.label }}</span>
              <span v-if="isNewOperation(operation)" class="shrink-0 rounded-[4px] px-1.5 text-[11px] text-nav-foreground bg-nav-selected" data-testid="extension-new-permission">{{ english ? 'New' : '新增' }}</span>
            </li>
          </ul>
          <p v-if="resource.scope" class="mt-1 mb-0 text-[12px] leading-[1.65] text-muted [overflow-wrap:anywhere]">
            {{ resource.scope }}
          </p>
        </dd>
      </div>
    </dl>
    <p v-else class="m-0 text-[12px] text-muted leading-[1.6]">
      {{ labels.none }}
    </p>
    <p v-if="sharesContent" class="mt-3 mb-0 flex items-start gap-2 text-[12px] leading-[1.65] text-warning" data-testid="extension-content-sharing-warning">
      <DesktopIcon class="mt-0.5 shrink-0" :component="Warning20Regular" :size="16" aria-hidden="true" />
      {{ english ? 'This plugin can send authorized content to the listed websites.' : '此插件可向列出的网站发送已授权读取的内容。' }}
    </p>
    <p v-if="review.currentVersion && !review.addedPermissions.length" class="mt-3 mb-0 text-[12px] text-muted leading-[1.6]">
      {{ labels.noAdded }}
    </p>
  </section>
</template>

<style scoped lang="scss">
.extension-review-permissions {
  container-type: inline-size;

  @container (max-width: 400px) {
    .extension-review-resource {
      grid-template-columns: minmax(0, 1fr);
    }
  }
}
</style>
