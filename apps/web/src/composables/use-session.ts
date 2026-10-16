import type { Provider, SessionResponse } from '@uselexora/lexora-contracts/community'
import { readonly, ref } from 'vue'
import { api } from '@/utils/axios'

const session = ref<SessionResponse>({ user: null, providers: [] })
const ready = ref(false)
export function useSession() {
  async function refresh() {
    session.value = (await api.get<SessionResponse>('/session')).data
    ready.value = true
  }
  async function signIn(provider: Provider, link = false) {
    const { data } = await api.post<{ url: string }>(`/auth/${provider}/start`, { link })
    window.location.assign(data.url)
  }
  async function signOut() {
    await api.post('/auth/logout', {})
    await refresh()
  }
  return { session: readonly(session), ready: readonly(ready), refresh, signIn, signOut }
}
