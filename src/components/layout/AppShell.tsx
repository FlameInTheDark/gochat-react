import type { ReactNode } from 'react'
import ServerSidebar from './ServerSidebar'

interface Props {
  children: ReactNode
}

export default function AppShell({ children }: Props) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      {/* Server list (leftmost column) */}
      <ServerSidebar />

      {/* Channel sidebar + main content */}
      <div className="flex flex-1 min-w-0">
        {/* children includes ChannelSidebar (from ServerLayout) + page content */}
        {children}
      </div>

      {/* User area is rendered inside ServerSidebar bottom */}
    </div>
  )
}
