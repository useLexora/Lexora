import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileStorage } from '../filesystem/fileStorage'
import { validateWindowsFilePath } from '../windows/filePath'

export function storageError(code: string): Error {
  return Object.assign(new Error(code), { code })
}
export function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}
export async function readStorageJson(path: string, maxBytes = 4 * 1024 * 1024): Promise<unknown | null> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes)
      throw storageError('STORAGE_INVALID_METADATA')
    return JSON.parse(await readFile(path, 'utf8'))
  }
  catch (error) {
    if (isMissing(error))
      return null
    throw error
  }
}
export async function writeStorageJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), `.storage-${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(value))
      await file.sync()
    }
    finally {
      await file.close()
    }
    await rename(temporary, path)
    await syncStorageDirectory(dirname(path))
  }
  finally {
    await unlink(temporary).catch((error) => {
      if (!isMissing(error))
        throw error
    })
  }
}
export async function syncStorageFile(path: string): Promise<void> {
  const file = await open(path, 'r+')
  try {
    await file.sync()
  }
  finally {
    await file.close()
  }
}
export async function syncStorageDirectory(path: string): Promise<void> {
  await fileStorage.syncDirectory(path)
}
export function containsStoragePath(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`))
}
export async function canonicalStoragePath(input: string): Promise<string> {
  if (!isAbsolute(input) || input.includes('\0'))
    throw storageError('STORAGE_INVALID_PATH')
  const path = process.platform === 'win32' ? validateWindowsFilePath(input) : resolve(input)
  try {
    return await realpath(path)
  }
  catch (error) {
    if (!isMissing(error))
      throw error
    if ((await lstat(path).catch((failure) => {
      if (!isMissing(failure))
        throw failure
      return null
    }))?.isSymbolicLink()) {
      throw storageError('STORAGE_INVALID_PATH')
    }
    const parent = dirname(path)
    if (parent === path)
      throw error
    return join(await canonicalStoragePath(parent), parse(path).base)
  }
}
export function readStorageJsonSync(path: string): unknown | null {
  try {
    const metadata = lstatSync(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024)
      throw storageError('STORAGE_INVALID_METADATA')
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  catch (error) {
    if (isMissing(error))
      return null
    throw error
  }
}
export function writeStorageJsonSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(file, JSON.stringify(value))
    fsyncSync(file)
  }
  finally {
    closeSync(file)
  }
  renameSync(temporary, path)
  if (process.platform !== 'win32') {
    const directory = openSync(dirname(path), 'r')
    try {
      fsyncSync(directory)
    }
    finally {
      closeSync(directory)
    }
  }
}
