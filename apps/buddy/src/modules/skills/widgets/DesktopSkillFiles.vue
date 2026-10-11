<script setup lang="ts">
import type { LocalSkill } from '@buddy-shared/skills/skillApi'
import { NSpin } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopContextFileTree from '@/shared/ui/files/DesktopContextFileTree.vue'
import DesktopContextSplit from '@/shared/ui/files/DesktopContextSplit.vue'
import DesktopFileToolbar from '@/shared/ui/files/DesktopFileToolbar.vue'
import DesktopMonacoFile from '@/shared/ui/files/DesktopMonacoFile.vue'
import { useSkillsContext } from '../skillsContext'
import { useSkillFilePreview } from '../state/useSkillFilePreview'

const props = defineProps<{ skill: LocalSkill, spaceId: string | null }>()
const context = useSkillsContext()
const { language } = useDesktopUi()
const { t } = useBuddyI18n(language)
const target = computed(() => ({ spaceId: props.spaceId, skill: props.skill }))
const { nodes, expandedKeys, path, preview, loading, failed, treeFailed, open, load } = useSkillFilePreview(context.api, target)
const wrap = shallowRef(true)
const treeVisible = shallowRef(true)
const treeWidth = shallowRef(220)
defineExpose({ open })
</script>

<template>
  <div class="skill-files flex flex-1 min-w-0 min-h-0 flex-col">
    <div class="flex flex-none h-10 border-b-1 border-b-solid border-b-border">
      <DesktopFileToolbar :path="path" :root-name="skill.name" :language="language" :wrap="wrap" :tree-visible="treeVisible" @toggle-wrap="wrap = !wrap" @toggle-tree="treeVisible = !treeVisible" />
    </div>
    <DesktopContextSplit v-model:width="treeWidth" :tree-visible="treeVisible">
      <div v-if="loading" class="skill-files__state grid flex-1 min-h-0 p-4 text-[0.8rem] text-muted">
        <NSpin size="small" />
      </div>
      <div v-else-if="failed" class="skill-files__state grid flex-1 min-h-0 p-4 text-[0.8rem] text-muted" role="alert">
        {{ t('desktop.context.previewLoadFailed') }}
      </div>
      <DesktopMonacoFile v-else-if="preview?.kind === 'text'" :text="preview.text ?? ''" :path="path" :wrap="wrap">
        <template #error>
          {{ t('desktop.context.editorLoadFailed') }}
        </template>
      </DesktopMonacoFile>
      <div v-else-if="preview?.kind === 'image'" class="skill-files__image grid w-full h-full overflow-auto place-items-center p-4">
        <img :src="preview.imageUrl ?? ''" :alt="path">
      </div>
      <div v-else class="skill-files__state grid flex-1 min-h-0 p-4 text-[0.8rem] text-muted">
        {{ t(preview ? 'desktop.context.previewUnavailable' : 'desktop.context.selectFile') }}
      </div>
      <template #tree>
        <div v-if="treeFailed" class="skill-files__state grid flex-1 min-h-0 p-4 text-[0.8rem] text-muted" role="alert">
          {{ t('desktop.context.directoryLoadFailed') }}
        </div>
        <DesktopContextFileTree v-model:expanded-keys="expandedKeys" :nodes="nodes" :selected-key="path" :language="language" :load="load" @select="open" />
      </template>
    </DesktopContextSplit>
  </div>
</template>

<style scoped lang="scss">
.skill-files__state { place-content: center; }
.skill-files__image img { max-width: 100%; max-height: 100%; object-fit: contain; }
</style>
