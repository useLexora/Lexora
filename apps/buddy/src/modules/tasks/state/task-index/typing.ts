import type { SpaceAdditionalDirectoryChanges } from '@buddy-shared/spaces/spaceApi'
import type { SpaceIcon, SpaceIconColor } from '@buddy-shared/spaces/spaceAppearance'

export interface TaskSpaceInput {
  additionalDirectoryChanges?: SpaceAdditionalDirectoryChanges
  icon: SpaceIcon
  iconColor: SpaceIconColor
  memoryScope: 'personal_and_space' | 'space_only'
  name: string
  primaryDirectory: TaskSpacePrimaryDirectoryInput | null
}

export interface TaskSpacePrimaryDirectoryInput {
  id: string | null
  root: string
}
