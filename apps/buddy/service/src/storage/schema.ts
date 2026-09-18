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

export interface BuddySchemaMigration {
  foreignKeys?: 'off'
  sql: string
  version: number
}

export const BUDDY_SCHEMA_VERSION = 20 as const

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
]
