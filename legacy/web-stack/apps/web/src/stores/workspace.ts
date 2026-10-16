import type {
  PersonalWorkspaceSummary,
  TeamWorkspaceSummary,
  WorkspaceType,
} from '@haohaoxue/lexora-contracts'
import type { DeepReadonly } from 'vue'
import { WORKSPACE_TYPE } from '@haohaoxue/lexora-contracts/workspace/constants'
import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import { getPersonalWorkspace } from '@/apis/workspace'
import { translate } from '@/i18n'
import { STORAGE_KEY } from '@/utils/storage'

export const WORKSPACE_PERSIST_KEY = STORAGE_KEY.workspace

/**
 * 空间切换列表项。
 */
export interface WorkspaceSwitcherItem {
  /**
   * 标识
   * @description 对应实际 workspace id。
   */
  id: string
  /**
   * 类型
   * @description PERSONAL 或 TEAM。
   */
  type: WorkspaceType
  /**
   * 标题
   * @description 菜单中展示的空间名称。
   */
  label: string
  /**
   * 副标题
   * @description 菜单中的辅助说明。
   */
  description?: string
  /**
   * 图标地址
   * @description 为空时使用名称首字符回退。
   */
  iconUrl: string | null
}

function clonePersonalWorkspace(
  workspace: PersonalWorkspaceSummary,
): PersonalWorkspaceSummary {
  return {
    id: workspace.id,
    type: workspace.type,
    name: workspace.name,
    description: workspace.description,
    iconUrl: workspace.iconUrl,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const _personalWorkspace = shallowRef<PersonalWorkspaceSummary | null>(null)
  const _teamWorkspaces = shallowRef<TeamWorkspaceSummary[]>([])
  const _selectedWorkspaceId = shallowRef<string | null>(null)
  const personalWorkspace = computed<DeepReadonly<PersonalWorkspaceSummary> | null>(() =>
    _personalWorkspace.value as DeepReadonly<PersonalWorkspaceSummary> | null,
  )
  const teamWorkspaces = computed<DeepReadonly<TeamWorkspaceSummary[]>>(() =>
    _teamWorkspaces.value as DeepReadonly<TeamWorkspaceSummary[]>,
  )
  const currentWorkspace = computed<DeepReadonly<PersonalWorkspaceSummary | TeamWorkspaceSummary> | null>(() => {
    if (_personalWorkspace.value) {
      return _personalWorkspace.value as DeepReadonly<PersonalWorkspaceSummary>
    }

    return null
  })
  const currentWorkspaceType = computed(() => currentWorkspace.value?.type ?? WORKSPACE_TYPE.PERSONAL)
  const currentWorkspaceLabel = computed(() => translate('workspace.personalSpace'))
  const switchableWorkspaces = computed<DeepReadonly<WorkspaceSwitcherItem[]>>(() => {
    const items: WorkspaceSwitcherItem[] = []

    if (_personalWorkspace.value) {
      items.push({
        id: _personalWorkspace.value.id,
        type: WORKSPACE_TYPE.PERSONAL,
        label: translate('workspace.personalSpace'),
        iconUrl: _personalWorkspace.value.iconUrl,
      })
    }

    return items as DeepReadonly<WorkspaceSwitcherItem[]>
  })

  function clear() {
    _personalWorkspace.value = null
    _teamWorkspaces.value = []
    _selectedWorkspaceId.value = null
  }

  function setPersonalWorkspace(nextWorkspace: PersonalWorkspaceSummary) {
    _personalWorkspace.value = clonePersonalWorkspace(nextWorkspace)
    normalizeSelectedWorkspace()
  }

  function setTeamWorkspaces(_nextWorkspaces: TeamWorkspaceSummary[] = []) {
    _teamWorkspaces.value = []
    normalizeSelectedWorkspace()
  }

  async function refreshVisibleWorkspaces() {
    const nextPersonalWorkspace = await getPersonalWorkspace()
    setVisibleWorkspaces({
      personalWorkspace: nextPersonalWorkspace,
      teamWorkspaces: [],
    })
  }

  async function ensurePersonalWorkspace(): Promise<PersonalWorkspaceSummary> {
    if (!_personalWorkspace.value) {
      await refreshVisibleWorkspaces()
    }

    if (!_personalWorkspace.value) {
      throw new Error(translate('workspace.personalNotFound'))
    }

    normalizeSelectedWorkspace()
    return _personalWorkspace.value
  }

  function upsertTeamWorkspace(nextWorkspace: TeamWorkspaceSummary) {
    _teamWorkspaces.value = []
    normalizeSelectedWorkspace()
    return nextWorkspace
  }

  async function createWorkspace(payload: {
    name: string
    description?: string
  }) {
    void payload
    throw new Error(translate('workspace.featureComingSoon'))
  }

  async function uploadWorkspaceIcon(workspaceId: string, file: File) {
    void workspaceId
    void file
    throw new Error(translate('workspace.featureComingSoon'))
  }

  async function deleteWorkspace(workspaceId: string) {
    void workspaceId
    throw new Error(translate('workspace.featureComingSoon'))
  }

  function selectWorkspace(workspaceId: string) {
    if (_personalWorkspace.value?.id === workspaceId) {
      _selectedWorkspaceId.value = workspaceId
      return
    }

    normalizeSelectedWorkspace()
  }

  function selectPersonalWorkspace() {
    if (!_personalWorkspace.value) {
      return
    }

    _selectedWorkspaceId.value = _personalWorkspace.value.id
  }

  function normalizeSelectedWorkspace() {
    if (_personalWorkspace.value?.id === _selectedWorkspaceId.value) {
      return
    }

    _selectedWorkspaceId.value = _personalWorkspace.value?.id ?? null
  }

  function setVisibleWorkspaces(payload: {
    personalWorkspace: PersonalWorkspaceSummary
    teamWorkspaces: TeamWorkspaceSummary[]
  }) {
    _personalWorkspace.value = clonePersonalWorkspace(payload.personalWorkspace)
    _teamWorkspaces.value = []
    normalizeSelectedWorkspace()
  }

  return {
    _personalWorkspace,
    _selectedWorkspaceId,
    _teamWorkspaces,
    currentWorkspace,
    currentWorkspaceLabel,
    currentWorkspaceType,
    deleteWorkspace,
    personalWorkspace,
    selectPersonalWorkspace,
    selectWorkspace,
    switchableWorkspaces,
    teamWorkspaces,
    uploadWorkspaceIcon,
    upsertTeamWorkspace,
    clear,
    createWorkspace,
    ensurePersonalWorkspace,
    normalizeSelectedWorkspace,
    refreshVisibleWorkspaces,
    setPersonalWorkspace,
    setVisibleWorkspaces,
    setTeamWorkspaces,
  }
}, {
  persist: {
    key: WORKSPACE_PERSIST_KEY,
    pick: ['_selectedWorkspaceId'],
  },
})
