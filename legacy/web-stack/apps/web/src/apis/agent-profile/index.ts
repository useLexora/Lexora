import type {
  AgentProfileSettings,
  UpdateAgentProfileModelPolicyRequest,
} from './typing'
import { axios } from '@/utils/axios'

export * from './typing'

export function getDefaultAgentProfileSettings(): Promise<AgentProfileSettings> {
  return axios.request({
    method: 'get',
    url: '/users/me/agent/profile',
  })
}

export function updateDefaultAgentProfileModel(
  data: UpdateAgentProfileModelPolicyRequest,
): Promise<AgentProfileSettings> {
  return axios.request({
    method: 'patch',
    url: '/users/me/agent/profile/model',
    data,
  })
}
