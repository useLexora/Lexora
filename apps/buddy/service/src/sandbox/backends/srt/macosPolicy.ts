const SYSTEM_READ_PATHS = ['/usr', '/bin', '/sbin', '/System/Library', '/System/Applications', '/Library/Apple', '/Library/Developer/CommandLineTools', '/opt/homebrew', '/private/etc/ssl', '/private/etc/localtime', '/private/etc/passwd', '/private/etc/group', '/private/etc/resolv.conf', '/private/etc/hosts', '/private/etc/services', '/private/var/db/dyld', '/private/var/db/timezone', '/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/fd']

export function createMacosSystemPolicy() {
  return {
    readPaths: SYSTEM_READ_PATHS,
    denyRead: ['/'],
    denyWrite: [] as string[],
    pathRoots: ['/usr', '/bin', '/opt/homebrew'],
    pathEntries: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'],
    runtime: {},
  }
}
