<script setup lang="ts">
import type { DownloadProxy, DownloadSettings } from '@buddy-shared/network/downloadSettings'
import type { ApplicationSettingsProps } from './typing'
import { downloadSettingsSchema } from '@buddy-shared/network/downloadSettings'
import { Add20Regular } from '@vicons/fluent'
import { NButton, NSwitch, useMessage } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useSettingMutation } from '../../state/useSettingMutation'
import DesktopSettingRow from '../shared/DesktopSettingRow.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'
import DesktopDownloadProxyDialog from './DesktopDownloadProxyDialog.vue'
import DesktopDownloadProxyRow from './DesktopDownloadProxyRow.vue'

const props = defineProps<ApplicationSettingsProps>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const { pending: pendingFields, save: updateSetting } = useSettingMutation<'downloads'>(
  patch => props.updateSettings(patch),
  () => message.error(t('desktop.settings.saveFailed')),
)
const pending = computed(() => pendingFields.value.has('downloads'))
const editing = shallowRef<DownloadProxy | null>(null)
const isNew = shallowRef(false)

async function save(patch: Partial<DownloadSettings>): Promise<boolean> {
  if (!props.config || pending.value)
    return false
  const downloads = downloadSettingsSchema.parse({ ...props.config.downloads, ...patch })
  return updateSetting('downloads', { downloads })
}

function edit(proxy?: Readonly<DownloadProxy>) {
  isNew.value = !proxy
  editing.value = proxy ? { ...proxy } : { id: crypto.randomUUID(), name: '', url: '', enabled: true }
}

async function submit(proxy: DownloadProxy) {
  if (!props.config)
    return
  const proxies = isNew.value
    ? [...props.config.downloads.proxies, proxy]
    : props.config.downloads.proxies.map(item => item.id === proxy.id ? proxy : { ...item })
  if (await save({ proxies }))
    editing.value = null
}

function toggle(id: string, enabled: boolean) {
  void save({ proxies: props.config!.downloads.proxies.map(proxy => ({ ...proxy, enabled: proxy.id === id ? enabled : proxy.enabled })) })
}

function remove(id: string) {
  void save({ proxies: props.config!.downloads.proxies.filter(proxy => proxy.id !== id).map(proxy => ({ ...proxy })) })
}

function move(index: number, direction: -1 | 1) {
  const proxies = props.config!.downloads.proxies.map(proxy => ({ ...proxy }))
  const target = index + direction
  if (target < 0 || target >= proxies.length)
    return
  const moved = proxies.splice(index, 1)[0]!
  proxies.splice(target, 0, moved)
  void save({ proxies })
}
</script>

<template>
  <section v-if="config" class="grid gap-3" data-testid="download-proxy-settings">
    <header class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="m-0 text-[0.92rem] font-600">
        {{ t('desktop.settings.downloads.title') }}
      </h2>
      <NButton size="small" secondary :disabled="pending || config.downloads.proxies.length >= 20" @click="edit()">
        <template #icon>
          <DesktopIcon :component="Add20Regular" :size="16" />
        </template>
        {{ t('desktop.settings.downloads.add') }}
      </NButton>
    </header>
    <DesktopSettingsGroup>
      <DesktopSettingRow v-slot="{ controlAttrs }" :label="t('desktop.settings.downloads.enabled')" :description="t('desktop.settings.downloads.description')" toggle class="[--setting-control-min:0px] [--setting-control-max:max-content]">
        <NSwitch v-bind="controlAttrs" size="small" :round="false" :value="config.downloads.enabled" :loading="pending" :disabled="pending" :aria-disabled="pending" @update:value="save({ enabled: $event })" />
      </DesktopSettingRow>
      <ol v-if="config.downloads.proxies.length" class="m-0 list-none p-0">
        <DesktopDownloadProxyRow
          v-for="(proxy, index) in config.downloads.proxies" :key="proxy.id"
          :proxy="proxy" :language="language" :disabled="pending" :index="index" :last="index === config.downloads.proxies.length - 1"
          @toggle="toggle(proxy.id, $event)" @edit="edit(proxy)" @remove="remove(proxy.id)" @move="move(index, $event)"
        />
      </ol>
      <p v-else class="m-0 px-[0.9rem] py-6 text-center text-[0.75rem] text-muted">
        {{ t('desktop.settings.downloads.empty') }}
      </p>
    </DesktopSettingsGroup>
    <p class="m-0 text-[0.7rem] leading-relaxed text-muted" role="status">
      {{ t(config.downloads.enabled ? 'desktop.settings.downloads.orderHelp' : 'desktop.settings.downloads.pausedHelp') }}
    </p>
    <DesktopDownloadProxyDialog v-if="editing" :proxy="editing" :is-new="isNew" :language="language" :pending="pending" @save="submit" @close="editing = null" />
  </section>
</template>
