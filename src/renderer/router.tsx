import {
  createRootRoute,
  createRoute,
  createRouter,
  createBrowserHistory,
  createMemoryHistory,
  Outlet,
} from '@tanstack/react-router';
import { DesktopPage, OverlayPage } from './routes/app';

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const desktopRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DesktopPage,
});
const overlayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/overlay',
  component: OverlayPage,
});
const isElectron = window.location.protocol === 'file:' || !!window.lonelyChat;
export const router = createRouter({
  routeTree: rootRoute.addChildren([desktopRoute, overlayRoute]),
  history: isElectron ? createMemoryHistory({ initialEntries: ['/'] }) : createBrowserHistory(),
  defaultPreload: 'intent',
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
