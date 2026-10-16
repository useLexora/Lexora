import type { App } from 'vue'
import type { Router } from 'vue-router'

export default async function setupRouter(app: App, router: Router) {
  app.use(router)
  await router.isReady()
}
