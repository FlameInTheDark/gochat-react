import { Compass, ChevronLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import UserArea from './UserArea'
import { cn } from '@/lib/utils'
import { useClientMode } from '@/hooks/useClientMode'

export default function DiscoverySidebar() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const isMobile = useClientMode() === 'mobile'

  return (
    <div className={cn('flex flex-col bg-sidebar', isMobile ? 'w-full flex-1 min-h-0 border-r border-sidebar-border' : 'min-w-0 flex-1')}>
      {isMobile && (
        <button
          onClick={() => navigate('/app')}
          className="flex items-center gap-2 px-3 h-10 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0 border-b border-sidebar-border"
        >
          <ChevronLeft className="w-4 h-4" />
          {t('channelSidebar.allServers')}
        </button>
      )}

      <div className="mx-2 mt-3 mb-2 flex h-12 items-center rounded-xl border border-white/[0.08] bg-white/[0.035] px-3 text-sm font-semibold shrink-0">
        <span className="text-sm">{t('discovery.title')}</span>
      </div>

      <ScrollArea className="app-scrollbar flex-1">
        <div className="space-y-1 px-2 pt-2 pb-4">
          <p className="px-1 pt-2 pb-2 text-[11px] font-semibold uppercase text-muted-foreground tracking-wide">
            {t('discovery.categoriesTitle')}
          </p>
          <Button variant="secondary" className="h-10 w-full justify-start gap-2 rounded-xl bg-white/[0.08] hover:bg-white/[0.11]">
            <Compass className="size-4" />
            {t('discovery.servers')}
          </Button>
        </div>
      </ScrollArea>

      {isMobile && (
        <div className="relative z-20 shrink-0 px-2 pb-2 pt-1">
          <UserArea />
        </div>
      )}
    </div>
  )
}
