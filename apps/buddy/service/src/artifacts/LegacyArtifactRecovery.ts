import type { BuddyRunEvent } from '../events/BuddyRunEvent'
import type { RunEventReader } from '../events/RunEventPorts'
import type { ArtifactRepository } from '../storage/artifactRepository'
import type { BuddyDataPaths } from '../storage/BuddyDataPaths'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { ArtifactService } from './ArtifactService'
import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { buddyRunOutputPayloadSchema } from '../../../shared/runs/runOutput'
import { inferArtifactMimeType } from './ArtifactService'

const legacyOutputTools = new Set([
  'lexora_artifact_present',
  'lexora_image_generate',
])

export async function reconcileLegacyArtifactOutputs(options: {
  artifacts: Pick<ArtifactRepository, 'findByCurrentPath' | 'findById'>
  catalogue: Pick<ArtifactService, 'recoverLegacyRecords'>
  conversations: Pick<ConversationRepository, 'findById'>
  eventLog: Pick<RunEventReader, 'listForConversation'>
  paths: Pick<BuddyDataPaths, 'conversationArtifactsDirectory' | 'conversationsDirectory'>
}): Promise<number> {
  const directories = await listDirectories(options.paths.conversationsDirectory)

  let recovered = 0
  for (const entry of directories) {
    if (!entry.isDirectory())
      continue
    const conversation = options.conversations.findById(entry.name)
    if (!conversation || conversation.deletedAt !== null)
      continue
    recovered += await recoverConversationArtifacts({
      artifacts: options.artifacts,
      catalogue: options.catalogue,
      conversationId: conversation.id,
      eventLog: options.eventLog,
      paths: options.paths,
    })
  }
  return recovered
}

async function listDirectories(directory: string) {
  try {
    return await readdir(directory, { encoding: 'utf8', withFileTypes: true })
  }
  catch {
    return []
  }
}

async function recoverConversationArtifacts(options: {
  artifacts: Pick<ArtifactRepository, 'findByCurrentPath' | 'findById'>
  catalogue: Pick<ArtifactService, 'recoverLegacyRecords'>
  conversationId: string
  eventLog: Pick<RunEventReader, 'listForConversation'>
  paths: Pick<BuddyDataPaths, 'conversationArtifactsDirectory'>
}): Promise<number> {
  const files = await listLegacyArtifactFiles(
    options.paths.conversationArtifactsDirectory(options.conversationId),
  )
  if (files === null)
    return 0

  const outputs = listLegacyOutputs(options.eventLog.listForConversation(options.conversationId, { limit: 10_000 }))
  if (
    outputs.length === 0
    || new Set(outputs.map(output => output.artifactId)).size !== outputs.length
  ) {
    return 0
  }

  if (files.items.length !== outputs.length)
    return 0
  for (const [index, output] of outputs.entries()) {
    const file = files.items[index]!
    const existing = options.artifacts.findById(output.artifactId)
    const path = options.artifacts.findByCurrentPath(options.conversationId, file.path)
    if ((existing && (existing.conversationId !== options.conversationId || existing.currentPath !== file.path)) || (path && path.id !== output.artifactId))
      return 0
  }

  return options.catalogue.recoverLegacyRecords(outputs.map((output, index) => {
    const file = files.items[index]!
    return {
      conversationId: options.conversationId,
      createdAt: output.createdAt,
      currentPath: file.path,
      directoryGrantId: options.conversationId,
      directoryRoot: files.root,
      id: output.artifactId,
      kind: 'file',
      mimeType: inferArtifactMimeType(file.path),
      name: basename(file.path),
      relativePath: basename(file.path),
      sizeBytes: file.sizeBytes,
      sourceArtifactId: null,
      updatedAt: output.createdAt,
    }
  }))
}

function listLegacyOutputs(events: readonly BuddyRunEvent[]): Array<{
  artifactId: string
  createdAt: string
  runId: string
  sequence: number
}> {
  return events.flatMap((event) => {
    if (event.type !== 'output.produced')
      return []
    const output = buddyRunOutputPayloadSchema.safeParse(event.payload)
    if (!output.success || !legacyOutputTools.has(output.data.sourceToolName))
      return []
    return output.data.artifactIds.map(artifactId => ({
      artifactId,
      createdAt: event.createdAt,
      runId: event.runId,
      sequence: event.sequence,
    }))
  }).sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
    || left.runId.localeCompare(right.runId)
    || left.sequence - right.sequence
  ))
}

async function listLegacyArtifactFiles(directory: string): Promise<{
  items: Array<{ path: string, sizeBytes: number }>
  root: string
} | null> {
  try {
    const root = await realpath(directory)
    const entries = await readdir(root, { withFileTypes: true })
    const items = (await Promise.all(entries.filter(entry => entry.isFile()).map(async (entry) => {
      const path = join(root, entry.name)
      const metadata = await stat(path)
      return metadata.isFile()
        ? { modifiedAt: metadata.mtimeMs, path, sizeBytes: metadata.size }
        : null
    }))).filter((item): item is NonNullable<typeof item> => item !== null).sort((left, right) => left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path))
    return { items, root }
  }
  catch {
    return null
  }
}
