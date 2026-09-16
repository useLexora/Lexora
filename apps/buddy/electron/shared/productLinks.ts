import buddyPackage from '../../package.json'

const repositoryUrl = new URL(buddyPackage.repository.url.replace(/^git\+/, '').replace(/\.git$/, ''))

export const RELEASES_API_URL = `https://api.github.com/repos${repositoryUrl.pathname}/releases?per_page=100`
export const FEEDBACK_ISSUE_URL = `${repositoryUrl.href}/issues/new`
export const DOCUMENTATION_URL = new URL('guide/quick-start', buddyPackage.homepage).href

export function isLexoraReleaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.origin === repositoryUrl.origin
      && !url.username
      && !url.password
      && url.pathname.startsWith(`${repositoryUrl.pathname}/releases/`)
  }
  catch {
    return false
  }
}
