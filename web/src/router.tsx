import { type ReactElement } from 'react'
import {
  Outlet,
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'

import { App } from './App.js'
import { isDashboardPage } from './types/dashboard.js'

function RootLayout(): ReactElement {
  return <Outlet />
}

const rootRoute = createRootRoute({
  component: RootLayout,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  loader: () => {
    return redirect({ to: '/$page', params: { page: 'issues' }, replace: true, throw: true })
  },
  component: () => null,
})

const dashboardPageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$page',
  loader: ({ params }) => {
    if (!isDashboardPage(params.page)) {
      return redirect({ to: '/$page', params: { page: 'issues' }, replace: true, throw: true })
    }
    return undefined
  },
  component: App,
})

const routeTree = rootRoute.addChildren([indexRoute, dashboardPageRoute])

type DashboardHistory = ReturnType<typeof createBrowserHistory>

interface CreateDashboardRouterOptions {
  history?: DashboardHistory
  isServer?: boolean
}

function createDefaultHistory(): DashboardHistory {
  if (typeof window === 'undefined') {
    return createMemoryHistory({ initialEntries: ['/issues'] })
  }
  return createBrowserHistory()
}

export function createDashboardRouter(options: CreateDashboardRouterOptions = {}) {
  return createRouter({
    routeTree,
    history: options.history ?? createDefaultHistory(),
    isServer: options.isServer,
  })
}

export const router = createDashboardRouter()

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
