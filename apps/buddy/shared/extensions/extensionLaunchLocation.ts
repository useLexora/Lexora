const locationPattern = /^<profile>\/cache\/extensions\/([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)\/launches$/

export function launchLocationExtensionId(location: unknown): string | undefined {
  if (typeof location !== 'string' || location.length > '<profile>/cache/extensions//launches'.length + 120)
    return undefined
  return locationPattern.exec(location)?.[1]
}
