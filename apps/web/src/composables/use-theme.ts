import { readonly, ref } from 'vue'

const dark = ref(localStorage.getItem('lexora.theme') === 'dark')
function apply() {
  document.documentElement.classList.toggle('dark', dark.value)
  localStorage.setItem('lexora.theme', dark.value ? 'dark' : 'light')
}
apply()
export function useTheme() {
  return { dark: readonly(dark), toggle: () => {
    dark.value = !dark.value
    apply()
  } }
}
