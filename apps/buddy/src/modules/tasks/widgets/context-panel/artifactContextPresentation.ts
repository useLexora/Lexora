import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ArtifactViewMode } from '@/modules/tasks/model/context-panel/taskContextPanel'

export function resolveFileType(artifact: LocalArtifact): string {
  const extension = artifact.name.split('.').at(-1)
  if (extension && extension !== artifact.name && /^[a-z0-9]{1,8}$/i.test(extension))
    return extension.toUpperCase()
  return artifact.mimeType.split('/').at(-1)?.split(/[.+-]/)[0]?.toUpperCase() || 'FILE'
}

export function formatDate(value: string, locale: BuddyLocale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

export function isMarkdownArtifact(artifact: Pick<LocalArtifact, 'kind' | 'name' | 'mimeType'>): boolean {
  return artifact.kind === 'file'
    && (artifact.mimeType === 'text/markdown' || /\.(?:md|markdown)$/i.test(artifact.name))
}

export function resolveArtifactDisplayMode(
  artifact: Pick<LocalArtifact, 'kind' | 'name' | 'mimeType'>,
  viewMode: ArtifactViewMode,
): ArtifactViewMode | 'file' | 'directory' {
  if (artifact.kind === 'directory')
    return 'directory'
  if (isMarkdownArtifact(artifact))
    return viewMode
  if (artifact.mimeType.startsWith('image/'))
    return 'preview'
  return isTextMimeType(artifact.mimeType) ? 'source' : 'file'
}

export function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/') || [
    'application/json',
    'application/toml',
    'application/xml',
    'application/yaml',
  ].includes(mimeType)
}
