import { useAuthSession } from './useAuthSession'

export function useAdminSession() {
  return useAuthSession()
}
