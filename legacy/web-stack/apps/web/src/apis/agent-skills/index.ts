import type {
  ListAgentSkillsResponse,
  MutateAgentSkillResponse,
  UpdateAgentSkillConfigRequest,
  UpdateAgentSkillConfigResponse,
} from './typing'
import { axios } from '@/utils/axios'

export * from './typing'

export function getAgentSkills(): Promise<ListAgentSkillsResponse> {
  return axios.request({
    method: 'get',
    url: '/users/me/agent/skills',
  })
}

export function installAgentSkill(skillKey: string): Promise<MutateAgentSkillResponse> {
  return axios.request({
    method: 'post',
    url: `/users/me/agent/skills/${encodeURIComponent(skillKey)}/install`,
  })
}

export function enableAgentSkill(skillKey: string): Promise<MutateAgentSkillResponse> {
  return axios.request({
    method: 'post',
    url: `/users/me/agent/skills/${encodeURIComponent(skillKey)}/enable`,
  })
}

export function disableAgentSkill(skillKey: string): Promise<MutateAgentSkillResponse> {
  return axios.request({
    method: 'post',
    url: `/users/me/agent/skills/${encodeURIComponent(skillKey)}/disable`,
  })
}

export function uninstallAgentSkill(skillKey: string): Promise<MutateAgentSkillResponse> {
  return axios.request({
    method: 'delete',
    url: `/users/me/agent/skills/${encodeURIComponent(skillKey)}`,
  })
}

export function updateAgentSkillConfig(
  skillKey: string,
  payload: UpdateAgentSkillConfigRequest,
): Promise<UpdateAgentSkillConfigResponse> {
  return axios.request({
    method: 'patch',
    url: `/users/me/agent/skills/${encodeURIComponent(skillKey)}/config`,
    data: payload,
  })
}
