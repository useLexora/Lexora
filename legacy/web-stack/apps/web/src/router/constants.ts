export const ADMIN_ROUTE_NAME = 'admin'

export const ADMIN_ROUTE_PATH = '/admin'

export const SKILLS_ROUTE_NAME = 'skills'

export const SKILLS_MARKET_ROUTE_NAME = 'skills-market'

export const SKILLS_ME_ROUTE_NAME = 'skills-me'

export function isAdminRoutePath(path: string) {
  return path === ADMIN_ROUTE_PATH || path.startsWith(`${ADMIN_ROUTE_PATH}/`)
}
