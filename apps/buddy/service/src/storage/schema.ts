import { BUDDY_V1_INITIAL_SCHEMA_SQL } from './migrations/v1Initial'
import { BUDDY_V2_CHANGE_SCHEMA_SQL } from './migrations/v2Change'
import { BUDDY_V3_SPACE_SCHEMA_SQL } from './migrations/v3Space'
import { BUDDY_V4_SPACE_SCHEMA_SQL } from './migrations/v4Space'
import { BUDDY_V5_ARTIFACT_SCHEMA_SQL } from './migrations/v5Artifact'
import { BUDDY_V6_PERMISSION_SCHEMA_SQL } from './migrations/v6Permission'
import { BUDDY_V7_ARTIFACT_OUTPUT_SCHEMA_SQL } from './migrations/v7ArtifactOutput'
import { BUDDY_V8_WEB_SCHEMA_SQL } from './migrations/v8Web'
import { BUDDY_V9_COMPOSER_SCHEMA_SQL } from './migrations/v9Composer'
import { BUDDY_V10_TREE_SCHEMA_SQL } from './migrations/v10Tree'
import { BUDDY_V11_SPACE_APPEARANCE_SCHEMA_SQL } from './migrations/v11SpaceAppearance'
import { BUDDY_V12_TASK_MARKS_SCHEMA_SQL } from './migrations/v12TaskMarks'
import { BUDDY_V13_CHAT_QUEUE_SCHEMA_SQL } from './migrations/v13ChatQueue'
import { BUDDY_V14_USAGE_SCHEMA_SQL } from './migrations/v14Usage'
import { BUDDY_V15_MODEL_SERVICES_SCHEMA_SQL } from './migrations/v15ModelServices'
import { BUDDY_V16_ATTACHMENT_NAMES_SCHEMA_SQL } from './migrations/v16AttachmentNames'
import { BUDDY_V17_SKILLS_SCHEMA_SQL } from './migrations/v17Skills'
import { BUDDY_V18_CONNECTORS_SCHEMA_SQL } from './migrations/v18Connectors'
import { BUDDY_V19_LOCAL_RESOURCES_SCHEMA_SQL } from './migrations/v19LocalResources'
import { BUDDY_V20_TASK_DRAFTS_SCHEMA_SQL } from './migrations/v20TaskDrafts'
import { BUDDY_V21_TITLE_SCHEMA_SQL } from './migrations/v21Title'
import { BUDDY_V22_EXTENSION_SCHEMA_SQL } from './migrations/v22Extension'
import { BUDDY_V23_PROVIDERS_SCHEMA_SQL } from './migrations/v23Providers'
import { BUDDY_V24_RUN_EVENT_CHECKPOINTS_SCHEMA_SQL } from './migrations/v24RunEventCheckpoints'
import { BUDDY_V25_MCP_TOOLS_SCHEMA_SQL } from './migrations/v25McpTools'
import { BUDDY_V26_BUDDIES_SCHEMA_SQL } from './migrations/v26Buddies'
import { BUDDY_V27_PROVIDER_METADATA_SCHEMA_SQL } from './migrations/v27ProviderMetadata'
import { BUDDY_V28_AVATARS_SCHEMA_SQL } from './migrations/v28BuddyAvatars'
import { BUDDY_V29_SESSION_REFERENCES_SCHEMA_SQL } from './migrations/v29SessionReferences'
import { BUDDY_V30_TASK_MODELS_SCHEMA_SQL } from './migrations/v30TaskModels'

import { BUDDY_V31_MUTATION_RECOVERY_SCHEMA_SQL } from './migrations/v31MutationRecovery'

import { BUDDY_V32_CHANGE_CAPTURE_SCHEMA_SQL } from './migrations/v32ChangeCapture'

import { BUDDY_V33_EXECUTION_WORK_SCHEMA_SQL } from './migrations/v33ExecutionWork'
import { BUDDY_V34_ACTOR_IDENTITY_SCHEMA_SQL } from './migrations/v34ActorIdentity'
import { BUDDY_V35_INPUT_DELIVERY_SCHEMA_SQL } from './migrations/v35InputDelivery'
import { BUDDY_V36_EXTENSION_CAPABILITIES_SCHEMA_SQL } from './migrations/v36ExtensionCapabilities'
import { BUDDY_V37_MODEL_TYPES_SCHEMA_SQL } from './migrations/v37ModelTypes'

export interface BuddySchemaMigration {
  foreignKeys?: 'off'
  sql: string
  version: number
}

export const BUDDY_SCHEMA_VERSION = 37 as const

export const BUDDY_SCHEMA_MIGRATIONS: readonly BuddySchemaMigration[] = [
  { sql: BUDDY_V1_INITIAL_SCHEMA_SQL, version: 1 },
  { sql: BUDDY_V2_CHANGE_SCHEMA_SQL, version: 2 },
  { sql: BUDDY_V3_SPACE_SCHEMA_SQL, version: 3 },
  { sql: BUDDY_V4_SPACE_SCHEMA_SQL, version: 4 },
  { sql: BUDDY_V5_ARTIFACT_SCHEMA_SQL, version: 5 },
  { foreignKeys: 'off', sql: BUDDY_V6_PERMISSION_SCHEMA_SQL, version: 6 },
  { foreignKeys: 'off', sql: BUDDY_V7_ARTIFACT_OUTPUT_SCHEMA_SQL, version: 7 },
  { sql: BUDDY_V8_WEB_SCHEMA_SQL, version: 8 },
  { sql: BUDDY_V9_COMPOSER_SCHEMA_SQL, version: 9 },
  { foreignKeys: 'off', sql: BUDDY_V10_TREE_SCHEMA_SQL, version: 10 },
  { sql: BUDDY_V11_SPACE_APPEARANCE_SCHEMA_SQL, version: 11 },
  { sql: BUDDY_V12_TASK_MARKS_SCHEMA_SQL, version: 12 },
  { sql: BUDDY_V13_CHAT_QUEUE_SCHEMA_SQL, version: 13 },
  { sql: BUDDY_V14_USAGE_SCHEMA_SQL, version: 14 },
  { sql: BUDDY_V15_MODEL_SERVICES_SCHEMA_SQL, version: 15 },
  { sql: BUDDY_V16_ATTACHMENT_NAMES_SCHEMA_SQL, version: 16 },
  { sql: BUDDY_V17_SKILLS_SCHEMA_SQL, version: 17 },
  { sql: BUDDY_V18_CONNECTORS_SCHEMA_SQL, version: 18 },
  { sql: BUDDY_V19_LOCAL_RESOURCES_SCHEMA_SQL, version: 19 },
  { foreignKeys: 'off', sql: BUDDY_V20_TASK_DRAFTS_SCHEMA_SQL, version: 20 },
  { sql: BUDDY_V21_TITLE_SCHEMA_SQL, version: 21 },
  { sql: BUDDY_V22_EXTENSION_SCHEMA_SQL, version: 22 },
  { sql: BUDDY_V23_PROVIDERS_SCHEMA_SQL, version: 23 },
  { sql: BUDDY_V24_RUN_EVENT_CHECKPOINTS_SCHEMA_SQL, version: 24 },
  { sql: BUDDY_V25_MCP_TOOLS_SCHEMA_SQL, version: 25 },
  { sql: BUDDY_V26_BUDDIES_SCHEMA_SQL, version: 26 },
  { sql: BUDDY_V27_PROVIDER_METADATA_SCHEMA_SQL, version: 27 },
  { sql: BUDDY_V28_AVATARS_SCHEMA_SQL, version: 28 },
  { sql: BUDDY_V29_SESSION_REFERENCES_SCHEMA_SQL, version: 29 },
  { sql: BUDDY_V30_TASK_MODELS_SCHEMA_SQL, version: 30 },
  { sql: BUDDY_V31_MUTATION_RECOVERY_SCHEMA_SQL, version: 31 },
  { sql: BUDDY_V32_CHANGE_CAPTURE_SCHEMA_SQL, version: 32 },
  { sql: BUDDY_V33_EXECUTION_WORK_SCHEMA_SQL, version: 33 },
  { sql: BUDDY_V34_ACTOR_IDENTITY_SCHEMA_SQL, version: 34 },
  { sql: BUDDY_V35_INPUT_DELIVERY_SCHEMA_SQL, version: 35 },
  { sql: BUDDY_V36_EXTENSION_CAPABILITIES_SCHEMA_SQL, version: 36 },
  { sql: BUDDY_V37_MODEL_TYPES_SCHEMA_SQL, version: 37 },
]
