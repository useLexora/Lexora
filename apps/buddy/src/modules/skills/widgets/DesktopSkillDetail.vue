<script setup lang="ts">
import type { LocalSkill, SkillDetail } from '@buddy-shared/skills/skillApi'
import { NAlert, NDrawer, NDrawerContent, NScrollbar, NSpin, NTab, NTabs, NTag } from 'naive-ui'
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopMonacoFile from '@/shared/ui/files/DesktopMonacoFile.vue'
import DesktopMarkdownContent from '@/shared/ui/markdown/DesktopMarkdownContent.vue'
import { useSkillsContext } from '../skillsContext'
import DesktopSkillDetailActions from './DesktopSkillDetailActions.vue'
import DesktopSkillFiles from './DesktopSkillFiles.vue'
import DesktopSkillInformation from './DesktopSkillInformation.vue'

const props = defineProps<{
  selected: LocalSkill | null
  detail: SkillDetail | null
  loading: boolean
  error: string | null
  busy: boolean
  spaceId: string | null
  related: readonly LocalSkill[]
}>()
const emit = defineEmits<{ close: [], closed: [], update: [skill: LocalSkill], remove: [skill: LocalSkill], reveal: [skill: LocalSkill], global: [], locate: [skill: LocalSkill] }>()
const { writeClipboardText } = useSkillsContext()
const { language } = useDesktopUi()
const { t } = useBuddyI18n(language)
const skill = computed(() => props.detail?.skill ?? props.selected)
const tab = shallowRef<'description' | 'files'>('description')
const source = shallowRef(false)
const files = useTemplateRef<InstanceType<typeof DesktopSkillFiles>>('files')
watch([() => props.selected?.id, () => props.spaceId], () => {
  tab.value = 'description'
  source.value = false
})

async function followLink(event: MouseEvent) {
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a') : null
  const href = anchor?.getAttribute('href')
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href))
    return
  event.preventDefault()
  let decoded: string
  try {
    decoded = decodeURIComponent(href)
  }
  catch { return }
  if (decoded.startsWith('#')) {
    if (decoded.length === 1)
      return
    const target = anchor?.closest('.skill-detail__document')?.querySelector(`#${CSS.escape(decoded.slice(1))}`)
    target?.scrollIntoView({ block: 'start' })
    return
  }
  tab.value = 'files'
  await nextTick()
  void files.value?.open(decoded.split('#')[0]!)
}
</script>

<template>
  <NDrawer class="skill-detail-drawer" :show="!!selected" width="min(60rem, calc(100vw - 3rem))" @update:show="value => !value && emit('close')" @after-leave="emit('closed')">
    <NDrawerContent v-if="skill" closable :native-scrollbar="false" :body-content-style="{ padding: '0', height: '100%', display: 'flex', flexDirection: 'column' }">
      <template #header>
        <div class="flex w-full min-w-0 items-center gap-4 font-sans">
          <span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[1.05rem]" :title="skill.name">{{ skill.name }}</span>
        </div>
      </template>
      <div class="skill-detail flex flex-1 min-h-0 min-w-0 flex-col text-fg font-sans">
        <div class="skill-detail__tabs flex flex-none items-center gap-4 py-0 px-6 border-b-1 border-b-solid border-b-border">
          <NTabs v-model:value="tab" type="line" :bar-width="28" :theme-overrides="{ tabBorderColor: 'transparent' }">
            <template #suffix>
              <DesktopSkillDetailActions v-model:source="source" :skill="skill" :language="language" :space-id="spaceId" :busy="busy" :show-source="tab === 'description' && !!detail" @reveal="emit('reveal', skill)" @global="emit('global')" @update="emit('update', skill)" @remove="emit('remove', skill)" />
            </template>
            <NTab name="description">
              {{ t('desktop.skills.detail.description') }}
            </NTab>
            <NTab name="files">
              {{ t('desktop.skills.detail.files') }}
            </NTab>
          </NTabs>
        </div>
        <DesktopSkillFiles v-if="tab === 'files'" ref="files" :key="skill.id" :skill="skill" :space-id="spaceId" />
        <div v-else-if="loading" class="skill-detail__state grid flex-1" role="status">
          <NSpin size="small" />
        </div>
        <NAlert v-else-if="error" class="skill-detail__error" type="error" :show-icon="false">
          {{ error }}
        </NAlert>
        <DesktopMonacoFile v-else-if="source && detail" :text="detail.content" :path="skill.filePath" :wrap="true">
          <template #error>
            {{ t('desktop.context.editorLoadFailed') }}
          </template>
        </DesktopMonacoFile>
        <NScrollbar v-else-if="detail" class="skill-detail__scroll">
          <div class="skill-detail__document grid gap-[1.1rem] pt-6 pr-7 pb-10 pl-7 text-[0.86rem]" @click="followLink">
            <DesktopSkillInformation :detail="detail" :language="language" :space-id="spaceId" />
            <NTag v-if="skill.status === 'manual_only' || skill.status === 'invalid'" size="small" :bordered="false">
              {{ t(`desktop.skills.status.${skill.status}`) }}
            </NTag>
            <div v-if="related.length" class="skill-detail__relations flex flex-col items-start gap-[0.4rem]">
              <button v-for="item in related" :key="item.id" type="button" @click="emit('locate', item)">
                {{ t(skill.shadowedBy ? 'desktop.skills.overriddenByGroup' : 'desktop.skills.overridesGroup', { source: t(`desktop.skills.group.${item.source}`), name: item.name }) }}
              </button>
            </div>
            <DesktopMarkdownContent :content="detail.body" :language="language" :write-clipboard-text="writeClipboardText" />
          </div>
        </NScrollbar>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped lang="scss">
.skill-detail__tabs :deep(.n-tabs) { flex: 1; }
.skill-detail__scroll { min-height: 0; flex: 1; }
.skill-detail__document { --buddy-chat-final-font-size: 0.86rem; --buddy-chat-final-line-height: 1.75; }
.skill-detail__document > .n-tag { justify-self: start; }
.skill-detail__relations button { border: 0; padding: 0; background: transparent; color: var(--buddy-accent-text); font: inherit; font-size: 0.76rem; cursor: pointer; }
.skill-detail__relations button:hover { text-decoration: underline; }
.skill-detail__relations button:focus-visible { outline: 2px solid var(--buddy-focus-ring); }
.skill-detail__state { place-content: center; }
.skill-detail__error { margin: 1.5rem; }
</style>
