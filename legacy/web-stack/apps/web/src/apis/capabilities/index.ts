import type { AuthCapabilities } from './typing'
import { axios } from '@/utils/axios'

export * from './typing'

export function getAuthCapabilities(): Promise<AuthCapabilities> {
  return axios.request({
    method: 'get',
    url: '/capabilities/auth',
  })
}
