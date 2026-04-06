import { type ReactElement } from 'react'
import {
  Outlet,
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useParams,
} from '@tanstack/react-router'

import { App } from './App.js'
import { type DashboardPage, isDashboardPage } from './types/dashboard.js'

function RootLayout(): ReactElement {
  return <Outlet />
}

function DashboardPageRoute(): ReactElement {
  const { page } = useParams({ from: '/$page' })
  return <App activePage={page as DashboardPage} />
}

function DashboardDetailRoute(): ReactElement {
  const { page, detailId } = useParams({ from: '/$page/$detailId' })
  if (page === 'issues') {
    return <App activePage="issues" issueDetailRunId={detailId} />
  }
  if (page === 'projects') {
    return <App activePage="projects" projectDetailRepo={detailId} />
  }
  return <App activePage={page as DashboardPage} />
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
  component: DashboardPageRoute,
})

const dashboardDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$page/$detailId',
  loader: ({ params }) => {
    if (!isDashboardPage(params.page)) {
      return redirect({ to: '/$page', params: { page: 'issues' }, replace: true, throw: true })
    }
    if (params.page !== 'issues' && params.page !== 'projects') {
      return redirect({ to: '/$page', params: { page: params.page }, replace: true, throw: true })
    }
    return undefined
  },
  component: DashboardDetailRoute,
})

const routeTree = rootRoute.addChildren([indexRoute, dashboardPageRoute, dashboardDetailRoute])

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
