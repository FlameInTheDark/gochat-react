import type { ReactNode } from 'react'
import ServerSidebar from './ServerSidebar'

interface Props {
  children: ReactNode
}

export default function AppShell({ children }: Props) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      <ServerSidebar />
      <div className="flex flex-1 min-w-0">
        {children}
      </div>
    </div>
  )
}
