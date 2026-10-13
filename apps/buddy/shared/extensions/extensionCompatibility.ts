import type { ExtensionMetadata } from './extensionManifest'
import { gtr, ltr, satisfies } from 'semver'
import { EXTENSION_API_VERSION } from './extensionManifest'

export interface ExtensionCompatibilityIssue {
  reason: 'app-too-old' | 'app-too-new' | 'api-unsupported' | 'format-unsupported' | 'app-version-unsupported' | 'manifest-invalid'
  currentVersion: string
  requiredVersion: string
  requiredApiVersion: number
}

export interface ExtensionIncompatibleReview {
  manifest: ExtensionMetadata
  incompatibility: ExtensionCompatibilityIssue
}

export function extensionCompatibilityIssue(manifest: ExtensionMetadata, version: string): ExtensionCompatibilityIssue | null {
  const options = { includePrerelease: true }
  const range = manifest.engines.lexora
  const issue = (reason: ExtensionCompatibilityIssue['reason']): ExtensionCompatibilityIssue => ({ reason, currentVersion: version, requiredVersion: range, requiredApiVersion: manifest.apiVersion })
  if (ltr(version, range, options))
    return issue('app-too-old')
  if (gtr(version, range, options))
    return issue('app-too-new')
  if (manifest.schemaVersion > 1)
    return issue('format-unsupported')
  if (manifest.apiVersion > EXTENSION_API_VERSION)
    return issue('api-unsupported')
  return satisfies(version, range, options) ? null : issue('app-version-unsupported')
}

export function extensionUpgradeSuggested(issue: ExtensionCompatibilityIssue): boolean {
  return ['app-too-old', 'api-unsupported', 'format-unsupported'].includes(issue.reason)
}

export class ExtensionCompatibilityError extends Error {
  readonly review: ExtensionIncompatibleReview

  constructor(manifest: ExtensionMetadata, incompatibility: ExtensionCompatibilityIssue) {
    super('EXTENSION_INCOMPATIBLE')
    this.review = { manifest, incompatibility }
  }
}
