import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import ServerSidebar from './ServerSidebar'
import MobileServerList from './mobile/MobileServerList'
import { useBackgroundStore } from '@/stores/backgroundStore'
import { useClientMode } from '@/hooks/useClientMode'

interface Props {
  children: ReactNode
}

export default function AppShell({ children }: Props) {
  const backgroundDataUrl = useBackgroundStore((s) => s.backgroundDataUrl)
  const isMobile = useClientMode() === 'mobile'
  const location = useLocation()

  // Determine route depth: /app → 1 part, /app/:serverId → 2 parts, etc.
  const parts = location.pathname.split('/').filter(Boolean)
  const hasServer = parts.length >= 2 // has serverId or @me segment

  if (isMobile) {
    if (!hasServer) {
      // Root /app → full-screen server list; still render children so modals mount
      return (
        <div className="h-dvh w-screen overflow-hidden bg-sidebar">
          <MobileServerList />
          <div className="hidden">{children}</div>
        </div>
      )
    }
    // /app/:serverId or deeper → children fill the screen (ChannelSidebar or ChannelPage)
    return (
      <div
        className="flex flex-col h-dvh w-screen overflow-hidden bg-background"
        style={backgroundDataUrl ? { backgroundImage: `url(${backgroundDataUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
      >
        {children}
      </div>
    )
  }

  // Desktop layout — unchanged
  return (
    <div className="flex h-dvh w-screen overflow-hidden bg-background">
      <ServerSidebar />
      <div
        className="flex flex-1 min-w-0 bg-cover bg-center bg-no-repeat"
        style={backgroundDataUrl ? { backgroundImage: `url(${backgroundDataUrl})` } : undefined}
      >
        {children}
      </div>
    </div>
  )
}
