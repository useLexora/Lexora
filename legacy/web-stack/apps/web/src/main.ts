import App from '@/App.vue'
import { createAppRouter } from '@/router'
import {
  setupAssets,
  setupAuth,
  setupCreateApp,
  setupRouter,
} from '@/setup'

async function bootstrap() {
  await setupAssets()

  const app = setupCreateApp(App)
  const router = createAppRouter()

  await setupAuth(router)
  await setupRouter(app, router)
  app.mount('#app')
}

void bootstrap()
