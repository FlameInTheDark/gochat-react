import type { ReactNode } from 'react'
import ServerSidebar from './ServerSidebar'
import UserArea from './UserArea'
import VoicePanel from '@/components/voice/VoicePanel'

interface DesktopNavShellProps {
  sidebar: ReactNode
  children: ReactNode
}

export default function DesktopNavShell({ sidebar, children }: DesktopNavShellProps) {
  return (
    <>
      <section className="flex h-full w-[368px] shrink-0 flex-col border-r border-white/[0.08] bg-sidebar">
        <div className="flex min-h-0 flex-1">
          <ServerSidebar />
          {sidebar}
        </div>

        <div className="shrink-0 space-y-2 bg-sidebar px-2 pb-2 pt-0">
          <VoicePanel />
          <UserArea />
        </div>
      </section>

      <div className="flex min-w-0 flex-1">
        {children}
      </div>
    </>
  )
}
