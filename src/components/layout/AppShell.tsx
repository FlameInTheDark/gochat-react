import type { ReactNode } from 'react'
import ServerSidebar from './ServerSidebar'
import { useBackgroundStore } from '@/stores/backgroundStore'

interface Props {
  children: ReactNode
}

export default function AppShell({ children }: Props) {
  const backgroundDataUrl = useBackgroundStore((s) => s.backgroundDataUrl)

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
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
