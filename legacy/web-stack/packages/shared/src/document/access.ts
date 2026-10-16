import type {
  DocumentAccessCapabilities,
  WorkspaceMemberRole,
  WorkspaceType,
} from '@haohaoxue/lexora-contracts'
import {
  WORKSPACE_MEMBER_ROLE,
  WORKSPACE_TYPE,
} from '@haohaoxue/lexora-contracts/workspace/constants'

const MAINTAINER_CAPABILITIES: DocumentAccessCapabilities = {
  canRead: true,
  canEdit: true,
  canCreateChild: true,
  canPublish: true,
  canMove: true,
  canTrash: true,
  canRestore: true,
}

const TEAM_MEMBER_CAPABILITIES: DocumentAccessCapabilities = {
  canRead: true,
  canEdit: true,
  canCreateChild: true,
  canPublish: false,
  canMove: false,
  canTrash: false,
  canRestore: false,
}

export function getWorkspaceDocumentAccessCapabilities(input: {
  workspaceType: WorkspaceType
  workspaceMemberRole?: WorkspaceMemberRole | null
}): DocumentAccessCapabilities | null {
  if (!input.workspaceMemberRole) {
    return null
  }

  if (input.workspaceType === WORKSPACE_TYPE.PERSONAL) {
    return input.workspaceMemberRole === WORKSPACE_MEMBER_ROLE.OWNER
      ? { ...MAINTAINER_CAPABILITIES }
      : null
  }

  if (input.workspaceType !== WORKSPACE_TYPE.TEAM) {
    return null
  }

  return input.workspaceMemberRole === WORKSPACE_MEMBER_ROLE.OWNER
    || input.workspaceMemberRole === WORKSPACE_MEMBER_ROLE.ADMIN
    ? { ...MAINTAINER_CAPABILITIES }
    : { ...TEAM_MEMBER_CAPABILITIES }
}
