import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Ghost } from 'lucide-react'

export default function NotFoundPage() {
  const navigate = useNavigate()
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center justify-center h-full w-full gap-4 text-center px-4">
      <Ghost className="w-16 h-16 text-muted-foreground opacity-40" />
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">{t('notFound.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('notFound.subtitle')}</p>
      </div>
      <Button variant="outline" onClick={() => navigate(-1)}>
        {t('notFound.back')}
      </Button>
    </div>
  )
}
