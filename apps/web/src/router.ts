import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [{ path: '/', component: () => import('./views/community/index.vue'), children: [
    { path: '', component: () => import('./views/community/pages/explore/index.vue') },
    { path: 'plugins/:id', component: () => import('./views/community/pages/detail/index.vue') },
    { path: '', component: () => import('./views/community/pages/manage/index.vue'), children: [
      { path: 'account', component: () => import('./views/community/pages/account/index.vue') },
      { path: 'publish', component: () => import('./views/community/pages/publish/index.vue') },
      { path: 'reviews', component: () => import('./views/community/pages/reviews/index.vue') },
    ] },
  ] }, { path: '/:pathMatch(.*)*', redirect: '/' }],
})
