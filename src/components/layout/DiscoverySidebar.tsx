import { Compass, ChevronLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import UserArea from './UserArea'
import { cn } from '@/lib/utils'
import { useClientMode } from '@/hooks/useClientMode'

export default function DiscoverySidebar() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const isMobile = useClientMode() === 'mobile'

  return (
    <div className={cn('flex flex-col bg-sidebar border-r border-sidebar-border', isMobile ? 'w-full flex-1 min-h-0' : 'w-60 shrink-0')}>
      {isMobile && (
        <button
          onClick={() => navigate('/app')}
          className="flex items-center gap-2 px-3 h-10 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0 border-b border-sidebar-border"
        >
          <ChevronLeft className="w-4 h-4" />
          {t('channelSidebar.allServers')}
        </button>
      )}

      <div className="h-12 flex items-center px-3 font-semibold border-b border-sidebar-border shrink-0">
        <span className="text-sm">{t('discovery.title')}</span>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2">
          <p className="px-2 pt-2 pb-1 text-xs font-semibold uppercase text-muted-foreground tracking-wider">
            {t('discovery.categoriesTitle')}
          </p>
          <Button variant="secondary" className="w-full justify-start gap-2">
            <Compass className="size-4" />
            {t('discovery.servers')}
          </Button>
        </div>
      </ScrollArea>

      <Separator />
      <div className="p-2 shrink-0">
        <UserArea />
      </div>
    </div>
  )
}
