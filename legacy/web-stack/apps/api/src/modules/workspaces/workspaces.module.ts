import { Module } from '@nestjs/common'
import { StorageModule } from '../../infrastructure/storage/storage.module'
import { DocumentsModule } from '../documents/documents.module'
import { PersonalWorkspacesService } from './personal-workspaces.service'
import { TeamWorkspaceInvitesService } from './team-workspace-invites.service'
import { TeamWorkspaceMembersService } from './team-workspace-members.service'
import { TeamWorkspacesService } from './team-workspaces.service'
import { WorkspacesController } from './workspaces.controller'

@Module({
  imports: [StorageModule, DocumentsModule],
  controllers: [WorkspacesController],
  providers: [PersonalWorkspacesService, TeamWorkspacesService, TeamWorkspaceMembersService, TeamWorkspaceInvitesService],
  exports: [PersonalWorkspacesService, TeamWorkspaceInvitesService],
})
export class WorkspacesModule {}
