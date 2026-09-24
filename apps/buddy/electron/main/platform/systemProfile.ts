import type { SystemUserProfile } from '../../shared/desktopApi'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_AVATAR_BYTES = 2 * 1024 * 1024

let cachedProfile: Promise<SystemUserProfile> | null = null

export function clearSystemUserProfileCache(): void {
  cachedProfile = null
}

export function getSystemUserProfile(): Promise<SystemUserProfile> {
  return cachedProfile ??= resolveSystemUserProfile().catch(() => ({
    username: getSafeUsername(),
    displayName: getSafeUsername(),
    hostname: os.hostname() || 'localhost',
    avatarUrl: null,
  }))
}

export async function resolveSystemUserProfile(): Promise<SystemUserProfile> {
  const username = getSafeUsername()
  const hostname = os.hostname() || 'localhost'
  const platform = process.platform

  let displayName = username
  let avatarUrl: string | null = null

  if (platform === 'darwin') {
    displayName = await resolveDarwinDisplayName(username)
    avatarUrl = await resolveDarwinAvatar(username)
  }
  else if (platform === 'win32') {
    displayName = await resolveWindowsDisplayName(username)
    avatarUrl = await resolveWindowsAvatar()
  }
  else {
    displayName = await resolveLinuxDisplayName(username)
    avatarUrl = await resolveLinuxAvatar()
  }

  return {
    username,
    displayName: displayName || username,
    hostname,
    avatarUrl,
  }
}

function getSafeUsername(): string {
  try {
    const userInfo = os.userInfo()
    if (userInfo.username)
      return userInfo.username
  }
  catch {}

  return process.env.USER || process.env.USERNAME || 'User'
}

async function resolveDarwinDisplayName(username: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('id', ['-F'], { timeout: 1000 })
    const trimmed = stdout.trim()
    if (trimmed)
      return trimmed
  }
  catch {}

  try {
    const { stdout } = await execFileAsync('dscl', ['.', '-read', `/Users/${username}`, 'RealName'], { timeout: 1000 })
    const trimmed = stdout.replace(/^RealName:\s*/m, '').trim()
    if (trimmed)
      return trimmed
  }
  catch {}

  return username
}

async function resolveDarwinAvatar(username: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('dscl', ['.', '-read', `/Users/${username}`, 'JPEGPhoto'], { timeout: 1000 })
    const hex = stdout.replace(/^dsAttrTypeNative:JPEGPhoto:\s*/m, '').replace(/\s+/g, '')
    if (hex && hex.length > 32) {
      const buffer = Buffer.from(hex, 'hex')
      if (buffer.length <= MAX_AVATAR_BYTES && buffer[0] === 0xFF && buffer[1] === 0xD8)
        return `data:image/jpeg;base64,${buffer.toString('base64')}`
    }
  }
  catch {}

  try {
    const { stdout } = await execFileAsync('dscl', ['.', '-read', `/Users/${username}`, 'Picture'], { timeout: 1000 })
    const picPath = stdout.replace(/^Picture:\s*/m, '').trim()
    if (picPath && existsSync(picPath)) {
      const fileStat = await stat(picPath)
      if (fileStat.isFile() && fileStat.size <= MAX_AVATAR_BYTES) {
        const buf = await readFile(picPath)
        const mime = picPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
        return `data:${mime};base64,${buf.toString('base64')}`
      }
    }
  }
  catch {}

  return null
}

async function resolveWindowsDisplayName(username: string): Promise<string> {
  try {
    const script = `(Get-CimInstance Win32_UserAccount -Filter "Name='$env:USERNAME'").FullName`
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 1500 })
    const trimmed = stdout.trim()
    if (trimmed)
      return trimmed
  }
  catch {}

  return username
}

async function resolveWindowsAvatar(): Promise<string | null> {
  try {
    const appData = process.env.APPDATA
    if (appData) {
      const dir = join(appData, 'Microsoft', 'Windows', 'AccountPictures')
      if (existsSync(dir)) {
        const files = await readdir(dir)
        const imageFile = files.find(f => /\.(?:png|jpg|jpeg)$/i.test(f))
        if (imageFile) {
          const fullPath = join(dir, imageFile)
          const fileStat = await stat(fullPath)
          if (fileStat.isFile() && fileStat.size <= MAX_AVATAR_BYTES) {
            const buf = await readFile(fullPath)
            const mime = imageFile.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
            return `data:${mime};base64,${buf.toString('base64')}`
          }
        }
      }
    }
  }
  catch {}

  return null
}

async function resolveLinuxDisplayName(username: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('getent', ['passwd', username], { timeout: 1000 })
    const fields = stdout.trim().split(':')
    if (fields.length >= 5) {
      const gecos = fields[4].split(',')[0].trim()
      if (gecos)
        return gecos
    }
  }
  catch {}

  return username
}

async function resolveLinuxAvatar(): Promise<string | null> {
  let home = ''
  try {
    home = os.homedir()
  }
  catch {
    home = process.env.HOME || ''
  }

  if (!home)
    return null

  const candidates = ['.face', '.face.icon', '.profile.png']
  for (const candidate of candidates) {
    const fullPath = join(home, candidate)
    try {
      if (existsSync(fullPath)) {
        const fileStat = await stat(fullPath)
        if (fileStat.isFile() && fileStat.size <= MAX_AVATAR_BYTES) {
          const buf = await readFile(fullPath)
          const mime = candidate.endsWith('.png') ? 'image/png' : 'image/jpeg'
          return `data:${mime};base64,${buf.toString('base64')}`
        }
      }
    }
    catch {}
  }

  return null
}
