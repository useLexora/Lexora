import type {
  GetSystemAdminAuditLogsQuery,
  GetSystemAdminUsersQuery,
  SystemAdminAuditLogListResponse,
  SystemAdminOverview,
  SystemAdminUserDetail,
  SystemAdminUserListResponse,
  SystemAuthGovernance,
  SystemEmailConfig,
  SystemEmailServiceStatus,
  TestSystemEmailConfigRequest,
  TestSystemEmailConfigResponse,
  UpdateSystemAdminUserResponse,
  UpdateSystemAdminUserStatusRequest,
  UpdateSystemAuthGovernanceRequest,
  UpdateSystemAuthInviteCodeRequest,
  UpdateSystemEmailConfigRequest,
  UpdateSystemEmailServiceStatusRequest,
} from './typing'
import { axios } from '@/utils/axios'

export * from './typing'

export function getSystemAdminOverview(): Promise<SystemAdminOverview> {
  return axios.request({
    method: 'get',
    url: '/system-admin/overview',
  })
}

export function getSystemAdminUsers(params: GetSystemAdminUsersQuery): Promise<SystemAdminUserListResponse> {
  return axios.request({
    method: 'get',
    url: '/system-admin/users',
    params,
  })
}

export function getSystemAdminUserDetail(id: string): Promise<SystemAdminUserDetail> {
  return axios.request({
    method: 'get',
    url: `/system-admin/users/${id}/detail`,
  })
}

export function updateSystemAdminUserStatus(
  id: string,
  data: UpdateSystemAdminUserStatusRequest,
): Promise<UpdateSystemAdminUserResponse> {
  return axios.request({
    method: 'patch',
    url: `/system-admin/users/${id}/status`,
    data,
  })
}

export function getSystemAuthGovernance(): Promise<SystemAuthGovernance> {
  return axios.request({
    method: 'get',
    url: '/system-admin/auth-governance',
  })
}

export function updateSystemAuthGovernance(
  data: UpdateSystemAuthGovernanceRequest,
): Promise<SystemAuthGovernance> {
  return axios.request({
    method: 'put',
    url: '/system-admin/auth-governance',
    data,
  })
}

export function updateSystemAuthInviteCode(
  data: UpdateSystemAuthInviteCodeRequest,
): Promise<SystemAuthGovernance> {
  return axios.request({
    method: 'put',
    url: '/system-admin/auth-governance/invite-code',
    data,
  })
}

export function getSystemEmailConfig(): Promise<SystemEmailConfig> {
  return axios.request({
    method: 'get',
    url: '/system-admin/email-config',
  })
}

export function getSystemEmailServiceStatus(): Promise<SystemEmailServiceStatus> {
  return axios.request({
    method: 'get',
    url: '/system-admin/email-service',
  })
}

export function updateSystemEmailConfig(
  data: UpdateSystemEmailConfigRequest,
): Promise<SystemEmailConfig> {
  return axios.request({
    method: 'put',
    url: '/system-admin/email-config',
    data,
  })
}

export function updateSystemEmailServiceStatus(
  data: UpdateSystemEmailServiceStatusRequest,
): Promise<SystemEmailServiceStatus> {
  return axios.request({
    method: 'patch',
    url: '/system-admin/email-service',
    data,
  })
}

export function testSystemEmailConfig(
  data: TestSystemEmailConfigRequest,
): Promise<TestSystemEmailConfigResponse> {
  return axios.request({
    method: 'post',
    url: '/system-admin/email-config/test',
    data,
  })
}

export function getSystemAdminAuditLogs(params: GetSystemAdminAuditLogsQuery): Promise<SystemAdminAuditLogListResponse> {
  return axios.request({
    method: 'get',
    url: '/system-admin/audit-logs',
    params,
  })
}
