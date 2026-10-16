import { Buffer } from 'node:buffer'
import { createHash, randomInt } from 'node:crypto'
import {
  SERVER_PATH,
  WORKSPACE_ICON_MAX_BYTES,
  WORKSPACE_ICON_MIME_TYPES,
} from '@haohaoxue/lexora-contracts'
import { BadRequestException } from '@nestjs/common'

const NON_ALPHANUMERIC_RE = /[^a-z0-9]+/g
const EDGE_DASH_RE = /^-+|-+$/g
const WHITESPACE_RE = /\s+/g
const STORAGE_KEY_RANDOM_UPPER_BOUND = 2 ** 32
const WORKSPACE_ICON_MIME_EXTENSION_MAP = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const

type WorkspaceIconMimeType = (typeof WORKSPACE_ICON_MIME_TYPES)[number]

function createSlugSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_RE, '-')
    .replace(EDGE_DASH_RE, '')
}

export function buildPersonalWorkspaceName(userCode: string): string {
  return `Personal ${userCode}`
}

export function buildPersonalWorkspaceSlug(userCode: string): string {
  return `personal-${userCode.toLowerCase()}`
}

export function normalizeWorkspaceSlugBase(name: string): string {
  const normalized = name
    .trim()
    .split(WHITESPACE_RE)
    .map(createSlugSegment)
    .filter(Boolean)
    .join('-')

  return normalized || 'team'
}

export async function resolveUniqueWorkspaceSlug(options: {
  baseSlug: string
  findWorkspaceBySlug: (slug: string) => Promise<{ id: string } | null>
}): Promise<string> {
  let attempt = 0

  while (true) {
    const slug = attempt === 0
      ? options.baseSlug
      : `${options.baseSlug}-${attempt + 1}`

    const existing = await options.findWorkspaceBySlug(slug)

    if (!existing) {
      return slug
    }

    attempt += 1
  }
}

export function createWorkspaceSlugResolver(
  db: {
    workspace: {
      findFirst: (args: {
        where: { slug: string }
        select: { id: true }
      }) => Promise<{ id: string } | null>
    }
  },
) {
  return (slug: string) => db.workspace.findFirst({
    where: { slug },
    select: { id: true },
  })
}

export function normalizeWorkspaceDescription(value?: string | null): string | null {
  const normalizedValue = value?.trim()

  return normalizedValue || null
}

export function buildWorkspaceIconStorageKey(workspaceId: string, mimeType: WorkspaceIconMimeType): string {
  const timestamp = Date.now()

  return `workspace-icon/${workspaceId}/${timestamp}-${createHash('sha1')
    .update(`${workspaceId}:${timestamp}:${randomInt(0, STORAGE_KEY_RANDOM_UPPER_BOUND)}`)
    .digest('hex')}.${WORKSPACE_ICON_MIME_EXTENSION_MAP[mimeType]}`
}

export function buildWorkspaceIconUrl(workspaceId: string): string {
  return `${SERVER_PATH}/workspaces/icon/${workspaceId}?v=${Date.now()}`
}

export function assertWorkspaceIconMimeType(mimeType: string): WorkspaceIconMimeType {
  const normalizedMimeType = mimeType.trim().toLowerCase()

  if (WORKSPACE_ICON_MIME_TYPES.includes(normalizedMimeType as WorkspaceIconMimeType)) {
    return normalizedMimeType as WorkspaceIconMimeType
  }

  throw new BadRequestException('空间图标仅支持 JPG、PNG、WEBP 格式')
}

export function assertWorkspaceIconBuffer(buffer: Buffer, mimeType: WorkspaceIconMimeType): void {
  if (!buffer.length) {
    throw new BadRequestException('空间图标文件不能为空')
  }

  if (buffer.length > WORKSPACE_ICON_MAX_BYTES) {
    throw new BadRequestException('空间图标大小不能超过 2MB')
  }

  if (!isWorkspaceIconSignatureMatched(buffer, mimeType)) {
    throw new BadRequestException('空间图标文件格式不正确')
  }
}

function isWorkspaceIconSignatureMatched(buffer: Buffer, mimeType: WorkspaceIconMimeType): boolean {
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF
  }

  if (mimeType === 'image/png') {
    return buffer.length >= 8
      && buffer[0] === 0x89
      && buffer[1] === 0x50
      && buffer[2] === 0x4E
      && buffer[3] === 0x47
      && buffer[4] === 0x0D
      && buffer[5] === 0x0A
      && buffer[6] === 0x1A
      && buffer[7] === 0x0A
  }

  return buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
}
