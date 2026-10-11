import { createApp } from 'vue'
import App from '@/App.vue'
import { createDesktopRouter } from '@/app/router'
import { initializeDesktopTheme } from '@/theme/desktopThemeState'
import '@/theme/index.scss'
import 'virtual:uno.css'

const stopTheme = initializeDesktopTheme()
if (import.meta.hot)
  import.meta.hot.dispose(stopTheme)

createApp(App)
  .use(createDesktopRouter())
  .mount('#app')
