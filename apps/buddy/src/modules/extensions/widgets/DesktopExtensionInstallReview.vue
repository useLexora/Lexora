<script setup lang="ts">
import type { ExtensionReview } from '@buddy-shared/extensions/extensionApi'
import type { FileOpeningChoice, FileOpeningReviewChoice } from '@buddy-shared/files/fileOpening'
import { extensionCommandNamespace } from '@buddy-shared/extensions/extensionCommands'
import { Alert20Regular, Clock20Regular, Document20Regular, Globe20Regular, Warning20Regular } from '@vicons/fluent'
import { NButton, NCheckbox, NEllipsis, NModal, NTag } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopPluginIcon from '@/shared/ui/icon/DesktopPluginIcon.vue'
import { extensionLabels } from '../extensionLabels'
import DesktopExtensionFileAssociations from './DesktopExtensionFileAssociations.vue'

const props = defineProps<{ review: ExtensionReview, language: string, busy: boolean }>()
const emit = defineEmits<{ cancel: [], install: [applyUpdate: boolean, choices: FileOpeningChoice[]] }>()
const applyUpdate = shallowRef(true)
const associations = computed(() => props.review.fileAssociations ?? [])
const skills = computed(() => props.review.manifest.contributes.skills.map(skill => ({
  id: skill.id,
  invocation: `$${extensionCommandNamespace(props.review.manifest.id)}:${skill.path.split('/').at(-2)}`,
})))
const selectedAssociations = shallowRef(initialAssociations())
function initialAssociations(): FileOpeningChoice[] {
  const selected = new Map<string, FileOpeningReviewChoice>()
  for (const choice of associations.value) {
    const key = `${choice.extension}:${choice.location}`
    if (choice.providerId === choice.currentProviderId || (choice.requestDefault && !selected.has(key)))
      selected.set(key, choice)
  }
  return [...selected.values()]
    .map(({ extension, location, providerId }) => ({ extension, location, providerId }))
}
function install() {
  const changes = selectedAssociations.value.filter(selected => associations.value.some(choice => choice.extension === selected.extension && choice.location === selected.location && choice.providerId === selected.providerId && choice.currentProviderId !== selected.providerId))
  emit('install', applyUpdate.value, changes)
}
const labels = computed(() => extensionLabels(props.language))
const english = computed(() => props.language === 'en-US')
const permissions = computed(() => {
  const { permissions } = props.review.manifest
  return [
    ...(permissions.shells ? [{ key: 'shells', icon: Alert20Regular, title: english.value ? 'Detect local command interpreters' : '检测本机命令解释器', description: english.value ? 'Read interpreter paths and versions. Only interpreters you enable in native settings become model choices; Lexora executes commands under your existing permissions. The plugin cannot run commands or change executable paths.' : '读取解释器路径和版本。只有你在原生设置中启用的候选才可供模型选择，命令仍由 Lexora 按现有权限执行；插件不能执行命令或修改解释器路径。' }] : []),
    ...(permissions.agent ? [{ key: 'agent', icon: Alert20Regular, title: english.value ? 'Run plugin tools and actions' : '运行插件工具与动作', description: english.value ? 'Contribute model tools and run declared actions when task events occur or you request them.' : '提供模型工具，并在声明的任务事件发生或你主动请求时执行动作。' }] : []),
    ...(permissions.taskMessages ? [{ key: 'taskMessages', icon: Document20Regular, title: english.value ? 'Read task messages' : '读取任务消息', description: english.value ? 'Read a bounded text excerpt from the invoking task. Attachments and tool output are excluded.' : '读取触发任务的有限消息文本，不包含附件内容和工具输出。' }] : []),
    ...(permissions.models ? [{ key: 'models', icon: Alert20Regular, title: english.value ? 'Call configured models' : '调用已配置的模型', description: english.value ? 'Send tool-provided text to a configured model. Additional requests may incur usage costs. Credentials stay in Lexora.' : '将工具提供的文本发送给已配置的模型，额外请求可能产生费用；凭据不会交给插件。' }] : []),
    ...(permissions.tasks !== 'none' ? [{ key: `tasks:${permissions.tasks}`, icon: Document20Regular, title: english.value ? 'Access the invoking task' : '访问触发调用的任务', description: permissions.tasks === 'title' ? english.value ? 'Update generated titles; replace protected titles only when you explicitly run an action.' : '更新自动标题；只有你主动执行动作时才能替换受保护的标题。' : english.value ? 'Read title metadata of the task that invokes the tool.' : '读取调用工具的任务标题元数据。' }] : []),
    ...(permissions.windowEffects ? [{ key: 'windowEffects', icon: Alert20Regular, title: english.value ? 'Customize window appearance' : '自定义窗口外观', description: english.value ? 'Inject window CSS, draw effects and receive typing activity. Typed text and keys are never shared.' : '向 Lexora 窗口注入 CSS、绘制效果并接收对话输入活动；不会获取输入文字或按键。' }] : []),
    ...(permissions.controls.length ? [{ key: 'controls', icon: Alert20Regular, title: english.value ? 'Provide optional controls' : '提供可选控件', description: english.value ? 'After you enable a control, the plugin can submit your choices through it.' : '由你启用控件后，插件可以通过它提交你的选择。' }] : []),
    ...(permissions.notifications ? [{ key: 'notifications', icon: Alert20Regular, title: labels.value.notifications, description: english.value ? 'Show reminders in your system notification center.' : '通过系统通知向你发送提醒。' }] : []),
    ...(permissions.schedules ? [{ key: 'schedules', icon: Clock20Regular, title: english.value ? 'Run scheduled tasks' : '执行后台定时任务', description: english.value ? 'Continue running while Lexora is open, even when the plugin page is closed.' : 'Lexora 运行期间，关闭插件页面后仍可执行。' }] : []),
    ...(permissions.selectedResource === 'read' ? [{ key: 'selectedResource:read', icon: Document20Regular, title: labels.value.selected, description: english.value ? 'Read the content of files you select for this plugin.' : '读取你为此插件选中的文件内容。' }] : []),
    ...(permissions.selectedContent ? [{ key: 'selectedContent', icon: Document20Regular, title: english.value ? 'Read content you select' : '读取你选择的内容', description: english.value ? 'Receive the current draft or message when you invoke its action.' : '当你主动执行操作时，获取当前草稿或该条消息。' }] : []),
    ...(permissions.clipboardRead ? [{ key: 'clipboardRead', icon: Document20Regular, title: english.value ? 'Read the system clipboard' : '读取系统剪贴板', description: english.value ? 'Read text and HTML while this plugin view is visible and focused. This permission does not require a separate click for each read.' : '插件视图在前台可见并聚焦时，可读取剪贴板的文本和 HTML；授权后每次读取不再单独确认。' }] : []),
    ...(permissions.clipboardWrite ? [{ key: 'clipboardWrite', icon: Document20Regular, title: english.value ? 'Write to the system clipboard' : '写入系统剪贴板', description: english.value ? 'Replace clipboard text and HTML while this plugin view is visible and focused.' : '插件视图在前台可见并聚焦时，可替换系统剪贴板的文本和 HTML。' }] : []),
    ...(permissions.references ? [{ key: 'references', icon: Document20Regular, title: english.value ? 'Add references to drafts' : '向输入框添加引用', description: english.value ? 'Add or copy references from an interactive plugin view or authorized file snapshots. During a task, plugin tools may read references from this plugin that you have sent. This does not send messages or grant additional file access.' : '添加或复制交互视图内容与已授权文件快照的引用；任务中的插件工具可读取你已发送的本插件引用。不会发送消息或扩大文件访问权限。' }] : []),
    ...(permissions.localResources ? [{ key: 'localResources', icon: Document20Regular, title: english.value ? 'Read files and folders you select' : '读取你选择的文件和目录', description: english.value ? 'Choose files or folders in a system dialog. The plugin can read selected files and scan selected folders until you revoke access.' : '通过系统窗口选择文件或目录；插件可读取所选文件、扫描所选目录，授权保留到你撤销。' }] : []),
    ...(permissions.themeManagement ? [{ key: 'themeManagement', icon: Document20Regular, title: english.value ? 'Manage your themes' : '管理你的主题', description: english.value ? 'Save, preview and select themes. Package themes remain read-only.' : '保存、预览和切换主题；插件包内主题保持只读。' }] : []),
    ...(permissions.resourceExport ? [{ key: 'resourceExport', icon: Document20Regular, title: english.value ? 'Save files to a location you choose' : '保存文件到你选择的位置', description: english.value ? 'Each export opens a system save dialog. Reading a file does not grant permission to overwrite it.' : '每次导出都由你通过系统保存窗口选择目标；读取文件不会自动授予覆写权限。' }] : []),
    ...permissions.network.map(origin => ({ key: `network:${origin}`, icon: Globe20Regular, title: `${labels.value.network} ${origin}`, description: english.value ? 'Send requests to this website and read its responses.' : '向此网站发送请求并读取响应。' })),
  ]
})
function isNewPermission(key: string): boolean {
  return key === 'controls'
    ? props.review.addedPermissions.some(permission => permission.startsWith('controls:'))
    : props.review.addedPermissions.includes(key)
}
const source = computed(() => props.review.development ? (english.value ? 'Development folder' : '开发目录') : props.review.source ? (english.value ? 'Lexora Marketplace' : 'Lexora 插件市场') : (english.value ? 'Local package' : '本地插件包'))
const sharesContent = computed(() => (props.review.manifest.permissions.clipboardRead || props.review.manifest.permissions.selectedResource === 'read' || props.review.manifest.permissions.localResources || props.review.manifest.permissions.selectedContent) && props.review.manifest.permissions.network.length > 0)
</script>

<template>
  <NModal
    show
    preset="card"
    :title="english ? (review.currentVersion ? 'Update plugin' : 'Install plugin') : (review.currentVersion ? '更新插件' : '安装插件')"
    class="extension-install-review"
    content-class="min-h-0 overflow-y-auto overscroll-contain"
    :mask-closable="!busy"
    :closable="!busy"
    :close-on-esc="!busy"
    data-testid="extension-install-review"
    @update:show="value => { if (!value) emit('cancel') }"
  >
    <div class="flex items-center gap-3">
      <span class="grid shrink-0 w-[44px] h-[44px] place-items-center rounded-[10px] text-nav-foreground bg-nav-selected" aria-hidden="true">
        <DesktopPluginIcon :src="review.iconUrl" :size="28" />
      </span>
      <div class="min-w-0">
        <h2 class="m-0 text-fg text-[18px] font-semibold leading-[1.45] [overflow-wrap:anywhere]">
          {{ review.manifest.name }}
        </h2>
        <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
          <NEllipsis class="max-w-[220px]">
            {{ review.manifest.author || (english ? 'Author not provided' : '未提供作者') }}
          </NEllipsis>
          <span class="[font-variant-numeric:tabular-nums]">
            <template v-if="review.currentVersion">{{ review.currentVersion }} → </template>{{ review.manifest.version }}
          </span>
          <NTag size="small" :bordered="false">
            {{ source }}
          </NTag>
        </div>
      </div>
    </div>
    <p v-if="review.manifest.description" class="mt-3 mb-0 text-muted text-[13px] leading-[1.7] [overflow-wrap:anywhere]">
      {{ review.manifest.description }}
    </p>
    <section v-if="skills.length" class="mt-5" data-testid="extension-included-skills">
      <h3>{{ english ? 'Included skills' : '附带技能' }}</h3>
      <ul class="m-0 p-3 grid gap-1.5 list-none bg-subtle rounded-[8px]">
        <li v-for="skill in skills" :key="skill.id" class="text-fg text-[12px] [overflow-wrap:anywhere]">
          {{ skill.invocation }}
        </li>
      </ul>
      <p class="mt-2 mb-0 text-[12px] text-muted leading-[1.6]">
        {{ english ? 'Select these skills in a conversation after installation. They follow the plugin’s enabled state.' : '安装后可在对话中选择使用；随插件启停。' }}
      </p>
    </section>
    <section class="mt-5">
      <h3>{{ labels.permissions }}</h3>
      <ul v-if="permissions.length" class="m-0 p-3 grid gap-3 list-none bg-subtle rounded-[8px]">
        <li v-for="permission in permissions" :key="permission.key" class="grid grid-cols-[18px_minmax(0,1fr)] items-start gap-2">
          <DesktopIcon class="mt-0.5 text-muted" :component="permission.icon" :size="18" aria-hidden="true" />
          <div>
            <div class="flex flex-wrap items-center gap-[8px] text-fg text-[13px] leading-[1.6] [overflow-wrap:anywhere]">
              <span>{{ permission.title }}</span>
              <span v-if="review.currentVersion && isNewPermission(permission.key)" class="py-0 px-[5px] rounded-[4px] text-nav-foreground bg-nav-selected text-[11px]">{{ english ? 'New' : '新增' }}</span>
            </div>
            <p class="mt-0.5 mb-0 text-[12px] text-muted leading-[1.6]">
              {{ permission.description }}
            </p>
          </div>
        </li>
      </ul>
      <p v-else class="m-0 text-[12px] text-muted leading-[1.6]">
        {{ labels.none }}
      </p>
      <p v-if="review.currentVersion && !review.addedPermissions.length" class="mt-3 mb-0 text-[12px] text-muted leading-[1.6]">
        {{ labels.noAdded }}
      </p>
    </section>
    <DesktopExtensionFileAssociations
      v-if="associations.length"
      v-model="selectedAssociations"
      class="mt-5"
      :associations="associations" :language="language" :busy="busy"
    />
    <section v-if="Object.keys(review.manifest.dependencies).length" class="mt-5">
      <h3>{{ labels.dependencies }}</h3>
      <p v-for="(range, id) in review.manifest.dependencies" :key="id" class="mt-1 mb-0 text-fg text-[12px] [overflow-wrap:anywhere]">
        {{ id }} <span class="text-muted">{{ range }}</span>
      </p>
    </section>
    <p v-if="sharesContent" class="mt-4 mb-0 text-muted text-[12px] leading-[1.6]">
      {{ english ? 'This plugin can send authorized content to the listed websites.' : '此插件可以向上述网站发送已授权读取的内容。' }}
    </p>
    <div v-if="review.currentVersion" class="mt-5 border-t border-t-solid border-t-border pt-4">
      <NCheckbox v-model:checked="applyUpdate" :disabled="busy">
        {{ labels.applyAfterInstall }}
      </NCheckbox>
      <p v-if="applyUpdate" class="mt-1 mb-0 text-[12px] text-muted leading-[1.6]">
        {{ labels.applyUpdateHint }}
      </p>
    </div>
    <template #footer>
      <div class="flex flex-wrap items-center justify-end gap-3">
        <p class="m-0 mr-auto flex items-center gap-1.5 text-[12px] font-medium text-warning leading-[1.6]">
          <DesktopIcon class="shrink-0" :component="Warning20Regular" :size="16" aria-hidden="true" />
          {{ english ? 'Only install plugins from sources you trust.' : '请确认你信任此插件的来源。' }}
        </p>
        <NButton :disabled="busy" @click="emit('cancel')">
          {{ labels.cancel }}
        </NButton>
        <NButton type="primary" :loading="busy" data-testid="extension-confirm-install" @click="install">
          {{ review.currentVersion ? (applyUpdate ? labels.updateAndApply : labels.update) : labels.confirm }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
:global(.extension-install-review) {
  width: min(660px, calc(100vw - 32px));
  max-height: calc(100dvh - 48px);
  border-radius: 12px;
}

.extension-install-review {
  :deep(.n-card-header) {
    flex-shrink: 0;
    padding: 20px 24px 16px;
  }

  :deep(.n-card-header__main) {
    font-size: 16px;
    font-weight: 600;
  }

  :deep(.n-card-content) {
    padding: 4px 24px 20px;
  }

  :deep(.n-card__footer) {
    flex-shrink: 0;
    padding: 16px 24px;
    border-top: 1px solid var(--buddy-border-subtle);
  }

  h3 {
    margin: 0 0 10px;
    color: var(--buddy-text-strong);
    font-size: 13px;
    font-weight: 600;
    line-height: 1.5;
  }
}
</style>
