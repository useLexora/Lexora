import type {
  CreateTeamWorkspaceRequest,
  CreateWorkspaceInviteRequest,
  PersonalWorkspaceSummary,
  TeamWorkspaceSummary,
  TransferTeamWorkspaceOwnershipRequest,
  WorkspaceInviteSummary,
  WorkspaceMemberSummary,
} from './typing'
import { axios } from '@/utils/axios'

export * from './typing'

export function getPersonalWorkspace(): Promise<PersonalWorkspaceSummary> {
  return axios.request({
    method: 'get',
    url: '/workspaces/me/personal',
  })
}

export function getVisibleTeamWorkspaces(): Promise<TeamWorkspaceSummary[]> {
  return axios.request({
    method: 'get',
    url: '/workspaces/me/teams',
  })
}

export function createTeamWorkspace(
  data: CreateTeamWorkspaceRequest,
): Promise<TeamWorkspaceSummary> {
  return axios.request({
    method: 'post',
    url: '/workspaces',
    data,
  })
}

export function updateTeamWorkspaceIcon(
  workspaceId: string,
  file: File,
): Promise<TeamWorkspaceSummary> {
  const formData = new FormData()
  formData.set('file', file)

  return axios.request({
    method: 'put',
    url: `/workspaces/${workspaceId}/icon`,
    data: formData,
  })
}

export function deleteWorkspace(workspaceId: string): Promise<null> {
  return axios.request({
    method: 'delete',
    url: `/workspaces/${workspaceId}`,
  })
}

export function getWorkspaceMembers(workspaceId: string): Promise<WorkspaceMemberSummary[]> {
  return axios.request({
    method: 'get',
    url: `/workspaces/${workspaceId}/members`,
  })
}

export function transferTeamWorkspaceOwnership(
  workspaceId: string,
  data: TransferTeamWorkspaceOwnershipRequest,
): Promise<null> {
  return axios.request({
    method: 'post',
    url: `/workspaces/${workspaceId}/ownership/transfer`,
    data,
  })
}

export function leaveTeamWorkspace(workspaceId: string): Promise<null> {
  return axios.request({
    method: 'post',
    url: `/workspaces/${workspaceId}/leave`,
  })
}

export function removeTeamWorkspaceMember(
  workspaceId: string,
  memberUserId: string,
): Promise<null> {
  return axios.request({
    method: 'post',
    url: `/workspaces/${workspaceId}/members/${memberUserId}/remove`,
  })
}

export function getPendingWorkspaceInvites(workspaceId: string): Promise<WorkspaceInviteSummary[]> {
  return axios.request({
    method: 'get',
    url: `/workspaces/${workspaceId}/invites`,
  })
}

export function createWorkspaceInvite(
  workspaceId: string,
  data: CreateWorkspaceInviteRequest,
): Promise<WorkspaceInviteSummary> {
  return axios.request({
    method: 'post',
    url: `/workspaces/${workspaceId}/invites`,
    data,
  })
}

export function cancelWorkspaceInvite(
  workspaceId: string,
  inviteId: string,
): Promise<WorkspaceInviteSummary> {
  return axios.request({
    method: 'post',
    url: `/workspaces/${workspaceId}/invites/${inviteId}/cancel`,
  })
}

export function acceptWorkspaceInvite(inviteId: string): Promise<WorkspaceInviteSummary> {
  return axios.request({
    method: 'post',
    url: `/workspaces/invites/${inviteId}/accept`,
  })
}

export function declineWorkspaceInvite(inviteId: string): Promise<WorkspaceInviteSummary> {
  return axios.request({
    method: 'post',
    url: `/workspaces/invites/${inviteId}/decline`,
  })
}
