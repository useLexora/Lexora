<script setup lang="ts">
import type { ExtensionReview } from '@buddy-shared/extensions/extensionApi'
import { Alert20Regular, Clock20Regular, Document20Regular, Globe20Regular } from '@vicons/fluent'
import { NButton, NCheckbox, NEllipsis, NModal } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopPluginIcon from '@/shared/ui/icon/DesktopPluginIcon.vue'
import { extensionLabels } from '../extensionLabels'

const props = defineProps<{ review: ExtensionReview, language: string, busy: boolean }>()
const emit = defineEmits<{ cancel: [], install: [applyUpdate: boolean] }>()
const applyUpdate = shallowRef(true)
const labels = computed(() => extensionLabels(props.language))
const english = computed(() => props.language === 'en-US')
const permissions = computed(() => {
  const { permissions } = props.review.manifest
  return [
    ...(permissions.agent ? [{ key: 'agent', icon: Alert20Regular, title: english.value ? 'Run plugin tools and actions' : '运行插件工具与动作', description: english.value ? 'Contribute model tools and run declared actions when task events occur or you request them.' : '提供模型工具，并在声明的任务事件发生或你主动请求时执行动作。' }] : []),
    ...(permissions.taskMessages ? [{ key: 'taskMessages', icon: Document20Regular, title: english.value ? 'Read task messages' : '读取任务消息', description: english.value ? 'Read a bounded text excerpt from the invoking task. Attachments and tool output are excluded.' : '读取触发任务的有限消息文本，不包含附件内容和工具输出。' }] : []),
    ...(permissions.models ? [{ key: 'models', icon: Alert20Regular, title: english.value ? 'Call configured models' : '调用已配置的模型', description: english.value ? 'Send tool-provided text to a configured model. Additional requests may incur usage costs. Credentials stay in Lexora.' : '将工具提供的文本发送给已配置的模型，额外请求可能产生费用；凭据不会交给插件。' }] : []),
    ...(permissions.tasks !== 'none' ? [{ key: `tasks:${permissions.tasks}`, icon: Document20Regular, title: english.value ? 'Access the invoking task' : '访问触发调用的任务', description: permissions.tasks === 'title' ? english.value ? 'Update generated titles; replace protected titles only when you explicitly run an action.' : '更新自动标题；只有你主动执行动作时才能替换受保护的标题。' : english.value ? 'Read title metadata of the task that invokes the tool.' : '读取调用工具的任务标题元数据。' }] : []),
    ...(permissions.windowEffects ? [{ key: 'windowEffects', icon: Alert20Regular, title: english.value ? 'Display window effects' : '显示窗口特效', description: english.value ? 'Draw over Lexora and receive typing activity. Typed text and keys are never shared.' : '在 Lexora 窗口绘制效果，接收对话输入活动；不会获取输入文字或按键。' }] : []),
    ...(permissions.controls.length ? [{ key: 'controls', icon: Alert20Regular, title: english.value ? 'Provide optional controls' : '提供可选控件', description: english.value ? 'After you enable a control, the plugin can submit your choices through it.' : '由你启用控件后，插件可以通过它提交你的选择。' }] : []),
    ...(permissions.notifications ? [{ key: 'notifications', icon: Alert20Regular, title: labels.value.notifications, description: english.value ? 'Show reminders in your system notification center.' : '通过系统通知向你发送提醒。' }] : []),
    ...(permissions.schedules ? [{ key: 'schedules', icon: Clock20Regular, title: english.value ? 'Run scheduled tasks' : '执行后台定时任务', description: english.value ? 'Continue running while Lexora is open, even when the plugin page is closed.' : 'Lexora 运行期间，关闭插件页面后仍可执行。' }] : []),
    ...(permissions.selectedResource === 'read' ? [{ key: 'selectedResource:read', icon: Document20Regular, title: labels.value.selected, description: english.value ? 'Read the content of files you select for this plugin.' : '读取你为此插件选中的文件内容。' }] : []),
    ...(permissions.selectedContent ? [{ key: 'selectedContent', icon: Document20Regular, title: english.value ? 'Read content you select' : '读取你选择的内容', description: english.value ? 'Receive the current draft or message when you invoke its action.' : '当你主动执行操作时，获取当前草稿或该条消息。' }] : []),
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
const sharesContent = computed(() => (props.review.manifest.permissions.selectedResource === 'read' || props.review.manifest.permissions.localResources || props.review.manifest.permissions.selectedContent) && props.review.manifest.permissions.network.length > 0)
</script>

<template>
  <NModal
    show
    preset="card"
    :title="english ? (review.currentVersion ? 'Update plugin' : 'Install plugin') : (review.currentVersion ? '更新插件' : '安装插件')"
    class="extension-install-review"
    :mask-closable="!busy"
    :closable="!busy"
    :close-on-esc="!busy"
    data-testid="extension-install-review"
    @update:show="value => { if (!value) emit('cancel') }"
  >
    <div class="flex items-center gap-[14px]">
      <span class="extension-install-review__icon grid w-[44px] h-[44px] place-items-center rounded-[10px] text-nav-foreground bg-nav-selected" aria-hidden="true">
        <DesktopPluginIcon :src="review.iconUrl" :size="28" />
      </span>
      <div class="extension-install-review__heading min-w-0">
        <h2>{{ review.manifest.name }}</h2>
        <p class="flex flex-wrap items-center gap-[8px] mt-[5px] mr-0 mb-0 ml-0 text-muted text-[12px] leading-[1.5]">
          <span class="extension-install-review__version py-0 px-[6px] border-1 border-solid border-border rounded-[4px]">
            <template v-if="review.currentVersion">{{ review.currentVersion }} → </template>{{ review.manifest.version }}
          </span>
          <NEllipsis>{{ review.manifest.author || (english ? 'Unsigned' : '未署名') }}</NEllipsis>
        </p>
        <p class="flex flex-wrap items-center gap-[8px] mt-[5px] mr-0 mb-0 ml-0 text-muted text-[12px] leading-[1.5]">
          {{ source }}
        </p>
      </div>
    </div>
    <p v-if="review.manifest.description" class="mt-[16px] mr-0 mb-0 ml-0 text-muted text-[13px] leading-[1.7] [overflow-wrap:anywhere]">
      {{ review.manifest.description }}
    </p>
    <section class="extension-install-review__permissions mt-[24px]">
      <h3>{{ labels.permissions }}</h3>
      <ul v-if="permissions.length">
        <li v-for="permission in permissions" :key="permission.key">
          <DesktopIcon class="extension-install-review__permission-icon" :component="permission.icon" :size="18" aria-hidden="true" />
          <div>
            <div class="flex flex-wrap items-center gap-[8px] text-fg text-[13px] leading-[1.6] [overflow-wrap:anywhere]">
              <span>{{ permission.title }}</span>
              <span v-if="review.currentVersion && isNewPermission(permission.key)" class="py-0 px-[5px] rounded-[4px] text-nav-foreground bg-nav-selected text-[11px]">{{ english ? 'New' : '新增' }}</span>
            </div>
            <p>{{ permission.description }}</p>
          </div>
        </li>
      </ul>
      <p v-else class="extension-install-review__muted">
        {{ labels.none }}
      </p>
      <p v-if="review.currentVersion && !review.addedPermissions.length" class="extension-install-review__muted extension-install-review__unchanged">
        {{ labels.noAdded }}
      </p>
    </section>
    <section v-if="Object.keys(review.manifest.dependencies).length" class="extension-install-review__dependencies mt-[24px]">
      <h3>{{ labels.dependencies }}</h3>
      <p v-for="(range, id) in review.manifest.dependencies" :key="id">
        {{ id }} <span>{{ range }}</span>
      </p>
    </section>
    <p class="mt-[24px] mr-0 mb-0 ml-0 text-muted text-[12px] leading-[1.6]">
      {{ english ? 'Only install plugins from sources you trust.' : '请确认你信任此插件的来源。' }}
      <template v-if="sharesContent">
        {{ english ? 'This plugin can send authorized content to the listed websites.' : '此插件可以向上述网站发送已授权读取的内容。' }}
      </template>
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
      <div class="flex justify-end gap-[8px]">
        <NButton :disabled="busy" @click="emit('cancel')">
          {{ labels.cancel }}
        </NButton>
        <NButton type="primary" :loading="busy" data-testid="extension-confirm-install" @click="emit('install', applyUpdate)">
          {{ review.currentVersion ? (applyUpdate ? labels.updateAndApply : labels.update) : labels.confirm }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
:global(.extension-install-review) {
  width: min(500px, calc(100vw - 32px));
  max-height: calc(100dvh - 48px);
  border-radius: 12px;
}
.extension-install-review {
  :deep(.n-card-header) { padding: 20px 24px 0; }
  :deep(.n-card-header__main) { font-size: 16px; font-weight: 600; }
  :deep(.n-card__content) { overflow-y: auto; padding: 24px; }
  :deep(.n-card__footer) { padding: 16px 24px; border-top: 1px solid var(--buddy-border-subtle); }
}

.extension-install-review__icon { flex: 0 0 44px; }
.extension-install-review__heading h2 { margin: 0; color: var(--buddy-text-strong); font-size: 18px; font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
.extension-install-review__version { font-variant-numeric: tabular-nums; }
.extension-install-review h3 { margin: 0 0 12px; color: var(--buddy-text-strong); font-size: 13px; font-weight: 600; line-height: 1.5; }
.extension-install-review__permissions ul { display: grid; gap: 16px; margin: 0; padding: 0; list-style: none; }
.extension-install-review__permissions li { display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: start; gap: 10px; }
.extension-install-review__permission-icon { margin-top: 2px; color: var(--buddy-text-secondary); }

.extension-install-review__permissions li p { margin: 2px 0 0; color: var(--buddy-text-secondary); font-size: 12px; line-height: 1.6; }

.extension-install-review__muted { margin: 0; color: var(--buddy-text-secondary); font-size: 12px; line-height: 1.6; }
.extension-install-review__unchanged { margin-top: 12px; }
.extension-install-review__dependencies p { margin: 4px 0 0; color: var(--buddy-text-primary); font-size: 12px; overflow-wrap: anywhere; }
.extension-install-review__dependencies span { color: var(--buddy-text-secondary); }
</style>
