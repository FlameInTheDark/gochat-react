import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom'
import { useClientMode } from '@/hooks/useClientMode'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import TitleBar from '@/components/layout/TitleBar'
import LoginPage from '@/pages/LoginPage'
import RegisterPage from '@/pages/RegisterPage'
import ConfirmPage from '@/pages/ConfirmPage'
import InvitePage from '@/pages/InvitePage'
import ForgotPasswordPage from '@/pages/ForgotPasswordPage'
import ResetPasswordPage from '@/pages/ResetPasswordPage'
import AppLayout from '@/pages/app/AppLayout'
import MeLayout from '@/pages/app/MeLayout'
import ServerLayout from '@/pages/app/ServerLayout'
import ChannelPage from '@/pages/app/ChannelPage'
import MePage from '@/pages/app/MePage'
import DMPage from '@/pages/app/DMPage'
import CreateServerModal from '@/components/modals/CreateServerModal'
import CreateChannelModal from '@/components/modals/CreateChannelModal'
import CreateCategoryModal from '@/components/modals/CreateCategoryModal'


const isElectron = typeof window !== 'undefined' && !!window.electronAPI

// On desktop, /app redirects to /app/@me. On mobile, /app shows the server list.
function AppIndexRedirect() {
  const isMobile = useClientMode() === 'mobile'
  if (isMobile) return null
  return <Navigate to="@me" replace />
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

const router = createBrowserRouter([
  { path: '/', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  { path: '/confirm/:userId/:token', element: <ConfirmPage /> },
  { path: '/invite/:code', element: <InvitePage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset/:token', element: <ResetPasswordPage /> },
  {
    path: '/app',
    element: <AppLayout />,
    children: [
      { index: true, element: <AppIndexRedirect /> },
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
], { basename: import.meta.env.VITE_BASE_PATH || '/' })

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div className="flex flex-col h-dvh w-screen overflow-hidden">
          {isElectron && <TitleBar />}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <RouterProvider router={router} />
          </div>
        </div>
        {/* Global modals rendered outside router so they survive navigation */}
        <CreateServerModal />
        <CreateChannelModal />
        <CreateCategoryModal />
        <Toaster richColors position="bottom-right" />
      </TooltipProvider>
    </QueryClientProvider>
  )
}
