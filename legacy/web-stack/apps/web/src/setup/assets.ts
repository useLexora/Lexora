export default async function setupAssets() {
  await import('element-plus/theme-chalk/dark/css-vars.css')
  await import('virtual:uno.css')
  await import('@/assets/scss/index.scss')
  await import('@/assets/scss/override.css')
}
