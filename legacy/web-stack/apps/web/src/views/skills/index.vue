<script setup lang="ts">
import type {
  AgentAmapMcpSkillCredentialConfig,
  AgentLocationSkillConfig,
  AgentTimeSkillConfig,
  AgentTranslatorSkillConfig,
  AgentWebSearchSkillConfig,
} from '@haohaoxue/lexora-contracts'
import type { CSSProperties } from 'vue'
import type { SkillConfigDrawerKey } from './utils/config-drawers'
import type { AgentSkillCard } from '@/apis/agent-skills'
import { computed, onMounted, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import {
  disableAgentSkill,
  enableAgentSkill,
  getAgentSkills,
  installAgentSkill,
  uninstallAgentSkill,
  updateAgentSkillConfig,
} from '@/apis/agent-skills'
import Empty from '@/components/empty'
import PagePanel from '@/layouts/panels/page-panel'
import {
  SKILLS_MARKET_ROUTE_NAME,
  SKILLS_ME_ROUTE_NAME,
} from '@/router/constants'
import { resolveAgentSkillIcon } from '@/utils/agent-skills'
import { ElMessage, ElMessageBox } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'
import AmapMcpConfigDrawer from './components/amap-mcp-config-drawer/index.vue'
import LocationConfigDrawer from './components/location-config-drawer/index.vue'
import TimeConfigDrawer from './components/time-config-drawer/index.vue'
import TranslatorConfigDrawer from './components/translator-config-drawer/index.vue'
import WebSearchConfigDrawer from './components/web-search-config-drawer/index.vue'
import {
  AMAP_MCP_SKILL_KEY,
} from './utils/amap'
import { hasSkillConfigDrawer } from './utils/config-drawers'
import {
  LOCATION_SKILL_KEY,
} from './utils/location'
import {
  TIME_SKILL_KEY,
} from './utils/time'
import {
  TRANSLATOR_SKILL_KEY,
} from './utils/translator'
import {
  WEB_SEARCH_SKILL_KEY,
} from './utils/web-search'

type SkillsTabName = 'market' | 'me'
type SkillMoreCommand = 'config' | 'uninstall'
type SkillConfigFormValue
  = | AgentTimeSkillConfig
    | AgentLocationSkillConfig
    | AgentTranslatorSkillConfig
    | AgentWebSearchSkillConfig
    | AgentAmapMcpSkillCredentialConfig

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const skillsRouteNameByTab = {
  market: SKILLS_MARKET_ROUTE_NAME,
  me: SKILLS_ME_ROUTE_NAME,
} as const satisfies Record<SkillsTabName, string>

const allSkills = shallowRef<AgentSkillCard[]>([])
const mySkills = shallowRef<AgentSkillCard[]>([])
const loading = shallowRef(false)
const loadError = shallowRef<string | null>(null)
const mutatingSkillKey = shallowRef<string | null>(null)
const savingSkillConfigKey = shallowRef<string | null>(null)
const configuringSkill = shallowRef<AgentSkillCard | null>(null)
const timeConfigDrawerVisible = shallowRef(false)
const locationConfigDrawerVisible = shallowRef(false)
const translatorConfigDrawerVisible = shallowRef(false)
const webSearchConfigDrawerVisible = shallowRef(false)
const amapMcpConfigDrawerVisible = shallowRef(false)
const skillConfigDrawerByKey = {
  [TIME_SKILL_KEY]: {
    visible: timeConfigDrawerVisible,
    savedMessageKey: 'skills.time.saved',
    saveFailedMessageKey: 'skills.time.saveFailed',
  },
  [LOCATION_SKILL_KEY]: {
    visible: locationConfigDrawerVisible,
    savedMessageKey: 'skills.location.saved',
    saveFailedMessageKey: 'skills.location.saveFailed',
  },
  [TRANSLATOR_SKILL_KEY]: {
    visible: translatorConfigDrawerVisible,
    savedMessageKey: 'skills.translator.saved',
    saveFailedMessageKey: 'skills.translator.saveFailed',
  },
  [WEB_SEARCH_SKILL_KEY]: {
    visible: webSearchConfigDrawerVisible,
    savedMessageKey: 'skills.webSearch.saved',
    saveFailedMessageKey: 'skills.webSearch.saveFailed',
  },
  [AMAP_MCP_SKILL_KEY]: {
    visible: amapMcpConfigDrawerVisible,
    savedMessageKey: 'skills.amap.saved',
    saveFailedMessageKey: 'skills.amap.saveFailed',
  },
} as const satisfies Record<SkillConfigDrawerKey, {
  visible: typeof timeConfigDrawerVisible
  savedMessageKey: string
  saveFailedMessageKey: string
}>
const skillTooltipStyle: CSSProperties = {
  maxWidth: '20rem',
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  lineHeight: '1.5',
}

const activeTab = computed<SkillsTabName>({
  get() {
    if (route.name === SKILLS_MARKET_ROUTE_NAME) {
      return 'market'
    }

    return 'me'
  },
  set(tabName) {
    void router.push({
      name: skillsRouteNameByTab[tabName],
    })
  },
})
const installableSkills = computed(() => allSkills.value.filter(skill => skill.installMode === 'optional'))
const visibleSkills = computed(() => activeTab.value === 'me' ? mySkills.value : installableSkills.value)
const emptyDescription = computed(() => activeTab.value === 'market' ? t('skills.emptyMarket') : t('skills.emptyInstalled'))

onMounted(() => {
  void loadSkills()
})

async function loadSkills() {
  loading.value = true
  loadError.value = null
  try {
    const response = await getAgentSkills()
    allSkills.value = response.skills
    mySkills.value = response.mySkills
  }
  catch (error) {
    loadError.value = error instanceof Error ? error.message : t('skills.loadFailed')
  }
  finally {
    loading.value = false
  }
}

function hasSkillMoreActions(skill: AgentSkillCard) {
  return canOpenSkillConfig(skill) || skill.canUninstall
}

function canOpenSkillConfig(skill: AgentSkillCard) {
  return skill.canConfigure && hasSkillConfigDrawer(skill.key)
}

function canConfigureSkillBeforeInstall(skill: AgentSkillCard) {
  return !skill.installed
    && skill.canInstall
    && skill.configurable
    && hasSkillConfigDrawer(skill.key)
}

function isSkillToggleDisabled(skill: AgentSkillCard) {
  return (!skill.canEnable && !skill.canDisable) || Boolean(mutatingSkillKey.value)
}

function getMarketActionText(skill: AgentSkillCard) {
  if (skill.installed) {
    return t('skills.installed')
  }

  return t('skills.install')
}

function isMarketActionDisabled(skill: AgentSkillCard) {
  return skill.installed || !skill.canInstall || Boolean(mutatingSkillKey.value)
}

async function handleInstallSkill(skill: AgentSkillCard) {
  if (!skill.canInstall || mutatingSkillKey.value) {
    return
  }

  if (canConfigureSkillBeforeInstall(skill)) {
    handleOpenSkillConfig(skill)
    return
  }

  mutatingSkillKey.value = skill.key
  try {
    await installAgentSkill(skill.key)
    await loadSkills()
    ElMessage.success(t('skills.installedMessage'))
  }
  catch (error) {
    ElMessage.error(getRequestErrorDisplayMessage(error, t('skills.installFailed')))
  }
  finally {
    mutatingSkillKey.value = null
  }
}

async function handleEnableSkill(skill: AgentSkillCard) {
  if (!skill.canEnable || mutatingSkillKey.value) {
    return
  }

  mutatingSkillKey.value = skill.key
  try {
    await enableAgentSkill(skill.key)
    await loadSkills()
    ElMessage.success(t('skills.enabled'))
  }
  catch (error) {
    ElMessage.error(getRequestErrorDisplayMessage(error, t('skills.enableFailed')))
  }
  finally {
    mutatingSkillKey.value = null
  }
}

async function handleDisableSkill(skill: AgentSkillCard) {
  if (!skill.canDisable || mutatingSkillKey.value) {
    return
  }

  mutatingSkillKey.value = skill.key
  try {
    await disableAgentSkill(skill.key)
    await loadSkills()
    ElMessage.success(t('skills.disabled'))
  }
  catch (error) {
    ElMessage.error(getRequestErrorDisplayMessage(error, t('skills.disableFailed')))
  }
  finally {
    mutatingSkillKey.value = null
  }
}

async function handleUninstallSkill(skill: AgentSkillCard) {
  if (!skill.canUninstall || mutatingSkillKey.value) {
    return
  }

  try {
    await ElMessageBox.confirm(
      t('skills.removeConfirm', { name: skill.name }),
      t('skills.removeTitle'),
      {
        type: 'warning',
        confirmButtonText: t('skills.remove'),
        cancelButtonText: t('docs.common.cancel'),
      },
    )
  }
  catch {
    return
  }

  mutatingSkillKey.value = skill.key
  try {
    await uninstallAgentSkill(skill.key)
    await loadSkills()
    ElMessage.success(t('skills.removed'))
  }
  catch (error) {
    ElMessage.error(getRequestErrorDisplayMessage(error, t('skills.removeFailed')))
  }
  finally {
    mutatingSkillKey.value = null
  }
}

async function handleSkillToggleChange(skill: AgentSkillCard, value: boolean | string | number) {
  const nextEnabled = Boolean(value)
  if (nextEnabled === skill.enabled) {
    return
  }

  if (nextEnabled) {
    await handleEnableSkill(skill)
    return
  }

  await handleDisableSkill(skill)
}

function handleSkillMoreCommand(skill: AgentSkillCard, command: string | number | object) {
  const normalizedCommand = String(command) as SkillMoreCommand
  if (normalizedCommand === 'config') {
    handleOpenSkillConfig(skill)
    return
  }

  if (normalizedCommand === 'uninstall') {
    void handleUninstallSkill(skill)
  }
}

function handleOpenSkillConfig(skill: AgentSkillCard) {
  if (!canOpenSkillConfig(skill) && !canConfigureSkillBeforeInstall(skill)) {
    return
  }

  const drawer = getSkillConfigDrawer(skill.key)
  if (!drawer) {
    return
  }

  configuringSkill.value = skill
  Object.values(skillConfigDrawerByKey).forEach((definition) => {
    definition.visible.value = false
  })
  drawer.visible.value = true
}

async function handleSaveSkillConfig(config: SkillConfigFormValue) {
  const skill = configuringSkill.value
  if (!skill || savingSkillConfigKey.value) {
    return
  }

  const drawer = getSkillConfigDrawer(skill.key)
  if (!drawer) {
    return
  }

  savingSkillConfigKey.value = skill.key
  const installingSkill = !skill.installed
  if (installingSkill) {
    mutatingSkillKey.value = skill.key
  }
  try {
    await updateAgentSkillConfig(skill.key, { config })
    await loadSkills()
    drawer.visible.value = false
    ElMessage.success(t(installingSkill ? 'skills.installedMessage' : drawer.savedMessageKey))
  }
  catch (error) {
    ElMessage.error(getRequestErrorDisplayMessage(error, t(drawer.saveFailedMessageKey)))
  }
  finally {
    savingSkillConfigKey.value = null
    if (mutatingSkillKey.value === skill.key) {
      mutatingSkillKey.value = null
    }
  }
}

function getSkillConfigDrawer(skillKey: string): typeof skillConfigDrawerByKey[SkillConfigDrawerKey] | null {
  return hasSkillConfigDrawer(skillKey)
    ? skillConfigDrawerByKey[skillKey]
    : null
}
</script>

<template>
  <PagePanel>
    <template #header>
      <ElTabs v-model="activeTab" class="skills-view__tabs flex h-full max-w-full w-fit items-center">
        <ElTabPane name="market">
          <template #label>
            <span class="inline-flex h-[var(--default-header-height)] items-center pr-3.5 text-[15px] font-medium leading-none">
              {{ t('skills.market') }}
            </span>
          </template>
        </ElTabPane>
        <ElTabPane name="me">
          <template #label>
            <span class="inline-flex h-[var(--default-header-height)] items-center px-3.5 text-[15px] font-medium leading-none">
              {{ t('skills.mine') }}
            </span>
          </template>
        </ElTabPane>
      </ElTabs>
    </template>

    <section class="skills-view__body min-h-full">
      <ElSkeleton v-if="loading" animated :rows="8" class="max-w-5xl p-6" />
      <ElAlert
        v-else-if="loadError"
        :title="loadError"
        type="error"
        show-icon
        :closable="false"
        class="m-6 max-w-3xl"
      />
      <div v-else-if="visibleSkills.length === 0" class="flex min-h-[24rem] items-center justify-center p-6">
        <Empty :description="emptyDescription" />
      </div>
      <div v-else class="skills-view__grid mx-auto grid gap-4 p-5">
        <article
          v-for="skill in visibleSkills"
          :key="skill.key"
          class="skills-view__card"
        >
          <div class="flex min-w-0 items-start gap-4">
            <span class="skills-view__icon flex h-14 w-14 shrink-0 items-center justify-center">
              <SvgIcon v-bind="resolveAgentSkillIcon(skill)" size="1.65rem" />
            </span>
            <div class="min-w-0 flex-1 pt-0.5">
              <div class="flex min-w-0 items-start gap-3">
                <ElTooltip
                  :content="skill.name"
                  placement="top"
                  effect="dark"
                  :show-after="300"
                  :teleported="true"
                  :popper-style="skillTooltipStyle"
                >
                  <h2 class="skills-view__name m-0 min-w-0 flex-1 truncate text-base font-semibold leading-6 text-[var(--brand-text-primary)]">
                    {{ skill.name }}
                  </h2>
                </ElTooltip>

                <div v-if="activeTab === 'me'" class="skills-view__quick-actions flex shrink-0 items-center gap-1.5">
                  <ElSwitch
                    size="small"
                    :model-value="skill.enabled"
                    :loading="mutatingSkillKey === skill.key"
                    :disabled="isSkillToggleDisabled(skill)"
                    @change="value => handleSkillToggleChange(skill, value)"
                  />

                  <ElDropdown
                    v-if="hasSkillMoreActions(skill)"
                    trigger="click"
                    placement="bottom-end"
                    popper-class="skills-view__more-popper"
                    @command="command => handleSkillMoreCommand(skill, command)"
                  >
                    <ElButton
                      text
                      class="skills-view__more-btn h-7 min-w-7 w-7 rounded-lg p-0"
                      :disabled="Boolean(mutatingSkillKey)"
                      :aria-label="t('skills.moreActions')"
                    >
                      <SvgIcon category="ui" icon="more" size="0.95rem" />
                    </ElButton>

                    <template #dropdown>
                      <ElDropdownMenu class="skills-view__more-menu box-border min-w-0 w-32 p-1">
                        <ElDropdownItem
                          v-if="canOpenSkillConfig(skill)"
                          command="config"
                          class="skills-view__more-item min-h-8 px-2 text-main"
                        >
                          {{ t('skills.config') }}
                        </ElDropdownItem>
                        <ElDropdownItem
                          v-if="skill.canUninstall"
                          command="uninstall"
                          :divided="canOpenSkillConfig(skill)"
                          class="skills-view__more-item skills-view__more-item--danger min-h-8 px-2"
                        >
                          {{ t('skills.remove') }}
                        </ElDropdownItem>
                      </ElDropdownMenu>
                    </template>
                  </ElDropdown>
                </div>
              </div>

              <ElTooltip
                :content="skill.description"
                placement="top"
                effect="dark"
                :show-after="300"
                :teleported="true"
                :popper-style="skillTooltipStyle"
              >
                <p class="skills-view__description m-0 mt-2 line-clamp-2 text-sm leading-6 text-[var(--brand-text-secondary)]">
                  {{ skill.description }}
                </p>
              </ElTooltip>
            </div>
          </div>

          <div v-if="activeTab === 'market'" class="mt-5">
            <ElButton
              class="w-full"
              type="primary"
              plain
              :disabled="isMarketActionDisabled(skill)"
              :loading="mutatingSkillKey === skill.key"
              @click="handleInstallSkill(skill)"
            >
              {{ getMarketActionText(skill) }}
            </ElButton>
          </div>
        </article>
      </div>
    </section>

    <TimeConfigDrawer
      v-model:visible="timeConfigDrawerVisible"
      :skill="configuringSkill"
      :saving="savingSkillConfigKey === configuringSkill?.key"
      @submit="handleSaveSkillConfig"
    />
    <LocationConfigDrawer
      v-model:visible="locationConfigDrawerVisible"
      :skill="configuringSkill"
      :saving="savingSkillConfigKey === configuringSkill?.key"
      @submit="handleSaveSkillConfig"
    />
    <TranslatorConfigDrawer
      v-model:visible="translatorConfigDrawerVisible"
      :skill="configuringSkill"
      :saving="savingSkillConfigKey === configuringSkill?.key"
      @submit="handleSaveSkillConfig"
    />
    <WebSearchConfigDrawer
      v-model:visible="webSearchConfigDrawerVisible"
      :skill="configuringSkill"
      :saving="savingSkillConfigKey === configuringSkill?.key"
      @submit="handleSaveSkillConfig"
    />
    <AmapMcpConfigDrawer
      v-model:visible="amapMcpConfigDrawerVisible"
      :skill="configuringSkill"
      :saving="savingSkillConfigKey === configuringSkill?.key"
      @submit="handleSaveSkillConfig"
    />
  </PagePanel>
</template>

<style scoped lang="scss">
.skills-view__tabs {
  :deep(.el-tabs__header) {
    height: 100%;
    margin: 0;
  }

  :deep(.el-tabs__nav-wrap) {
    height: 100%;
  }

  :deep(.el-tabs__nav-scroll),
  :deep(.el-tabs__nav) {
    height: 100%;
  }

  :deep(.el-tabs__nav-wrap::after) {
    display: none;
  }

  :deep(.el-tabs__active-bar) {
    height: 0.1875rem;
    border-radius: 50%;
    background: var(--brand-primary);
  }

  :deep(.el-tabs__item) {
    height: 100%;
    color: var(--brand-text-secondary);
    padding: 0;
    transition: color 0.18s ease;
  }

  :deep(.el-tabs__item.is-active),
  :deep(.el-tabs__item:not(.is-disabled):hover) {
    color: var(--brand-text-primary);
  }

  :deep(.el-tabs__content) {
    display: none;
  }
}

.skills-view__body {
  background: var(--brand-bg-base);
}

.skills-view__grid {
  grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
}

.skills-view__card {
  border: 1px solid var(--brand-border-subtle);
  border-radius: 0.5rem;
  background: var(--brand-bg-surface);
  min-height: 9.5rem;
  padding: 1.5rem;
  transition:
    border-color 0.16s ease,
    background-color 0.16s ease,
    box-shadow 0.16s ease;

  &:hover {
    border-color: color-mix(in srgb, var(--brand-primary) 42%, var(--brand-border-subtle));
    box-shadow: 0 0.5rem 1.5rem color-mix(in srgb, var(--brand-primary) 8%, transparent);
  }
}

.skills-view__icon {
  border-radius: 0.5rem;
  color: var(--brand-primary);
  background: color-mix(in srgb, var(--brand-primary) 9%, var(--brand-bg-surface));
}

.skills-view__name {
  display: block;
}

.skills-view__more-btn {
  color: var(--brand-text-tertiary);

  &:hover,
  &:focus-visible {
    color: var(--brand-primary);
    background: color-mix(in srgb, var(--brand-primary) 7%, transparent);
  }
}

.skills-view__more-item--danger {
  color: var(--brand-error);
}

@media (max-width: 56rem) {
  .skills-view__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
