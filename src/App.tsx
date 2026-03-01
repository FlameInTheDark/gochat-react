import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import LoginPage from '@/pages/LoginPage'
import RegisterPage from '@/pages/RegisterPage'
import ConfirmPage from '@/pages/ConfirmPage'
import InvitePage from '@/pages/InvitePage'
import AppLayout from '@/pages/app/AppLayout'
import MeLayout from '@/pages/app/MeLayout'
import ServerLayout from '@/pages/app/ServerLayout'
import ChannelPage from '@/pages/app/ChannelPage'
import MePage from '@/pages/app/MePage'
import DMPage from '@/pages/app/DMPage'
import CreateServerModal from '@/components/modals/CreateServerModal'
import CreateChannelModal from '@/components/modals/CreateChannelModal'
import CreateCategoryModal from '@/components/modals/CreateCategoryModal'


const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

const router = createBrowserRouter([
  { path: '/', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  { path: '/confirm/:userId/:token', element: <ConfirmPage /> },
  { path: '/invite/:code', element: <InvitePage /> },
  {
    path: '/app',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="@me" replace /> },
      {
        path: '@me',
        element: <MeLayout />,
        children: [
          { index: true, element: <MePage /> },
          { path: ':userId', element: <DMPage /> },
        ],
      },
      {
        path: ':serverId',
        element: <ServerLayout />,
        children: [
          { path: ':channelId', element: <ChannelPage /> },
        ],
      },
    ],
  },
])

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
        {/* Global modals rendered outside router so they survive navigation */}
        <CreateServerModal />
        <CreateChannelModal />
        <CreateCategoryModal />
        <Toaster richColors position="bottom-right" />
      </TooltipProvider>
    </QueryClientProvider>
  )
}
