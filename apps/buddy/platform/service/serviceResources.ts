import { posix, win32 } from 'node:path'
import process from 'node:process'

export const PACKAGED_SERVICE_RESOURCES = 'lexora-service/resources'

export type ServiceResourceLocation = (
  | { appPath: string, resourcesPath: string, isPackaged: boolean }
  | { serviceResourcesRoot: string }
) & { platform?: NodeJS.Platform, architecture?: string }

export function resolveServiceResource(location: ServiceResourceLocation, resource: string, development: string): string {
  const paths = (location.platform ?? process.platform) === 'win32' ? win32 : posix
  if ('serviceResourcesRoot' in location)
    return paths.join(location.serviceResourcesRoot, resource)
  return location.isPackaged
    ? paths.join(location.resourcesPath, PACKAGED_SERVICE_RESOURCES, resource)
    : paths.join(location.appPath, development)
}
