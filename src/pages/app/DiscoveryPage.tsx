import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Bot, Compass, Search, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { guildApi, searchApi } from '@/api/client'
import { SearchGuildsGetSortEnum, type DtoGuildDiscovery } from '@/client'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useClientMode } from '@/hooks/useClientMode'

const PAGE_SIZE = 16

const QUICK_TAGS = [
  { key: 'discovery.quickCommunity', tag: 'community' },
  { key: 'discovery.quickGaming', tag: 'gaming' },
  { key: 'discovery.quickMusic', tag: 'music' },
  { key: 'discovery.quickEntertainment', tag: 'entertainment' },
  { key: 'discovery.quickScienceTech', tag: 'science-tech' },
  { key: 'discovery.quickEducation', tag: 'education' },
] as const

function parsePage(value: string | null): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

function formatMembers(t: ReturnType<typeof useTranslation>['t'], count: number): string {
  return t(count === 1 ? 'discovery.members' : 'discovery.membersPlural', { count })
}

function guildIdParam(guild: DtoGuildDiscovery): number {
  return String(guild.id ?? '') as unknown as number
}

function GuildDiscoveryCard({
  guild,
  joining,
  onJoin,
}: {
  guild: DtoGuildDiscovery
  joining: boolean
  onJoin: (guild: DtoGuildDiscovery) => void
}) {
  const { t } = useTranslation()
  const name = guild.name?.trim() || '?'
  const description = guild.description?.trim()
  const membersCount = guild.members_count ?? 0

  return (
    <article className="min-h-[214px] rounded-lg border bg-card p-4 shadow-sm transition-colors hover:border-primary/50">
      <div className="flex h-full flex-col gap-3">
        <div className="flex items-start gap-3">
          <Avatar className="size-14 rounded-lg">
            <AvatarImage src={guild.icon?.url} alt={name} className="object-cover" />
            <AvatarFallback className="rounded-lg text-base font-semibold">
              {name.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold leading-6">{name}</h2>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="size-3.5" />
              <span>{formatMembers(t, membersCount)}</span>
            </div>
          </div>
        </div>

        <p className="min-h-[40px] overflow-hidden text-sm leading-5 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
          {description || '\u00a0'}
        </p>

        <div className="flex min-h-6 flex-wrap gap-1.5 overflow-hidden">
          {(guild.tags ?? []).slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="max-w-full truncate rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
              aria-label={tag}
            >
              {tag}
            </span>
          ))}
        </div>

        <Button
          className="mt-auto w-full"
          size="sm"
          disabled={joining}
          onClick={() => onJoin(guild)}
        >
          {joining ? t('discovery.joining') : t('discovery.join')}
        </Button>
      </div>
    </article>
  )
}

export default function DiscoveryPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const isMobile = useClientMode() === 'mobile'
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get('q')?.trim() ?? ''
  const tag = searchParams.get('tag')?.trim() ?? ''
  const page = parsePage(searchParams.get('page'))
  const [draft, setDraft] = useState(q)

  useEffect(() => {
    setDraft(q)
  }, [q])

  const queryKey = useMemo(() => ['guildDiscovery', q, tag, page] as const, [q, tag, page])
  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () =>
      searchApi
        .searchGuildsGet({
          q: q || undefined,
          tags: tag || undefined,
          sort: SearchGuildsGetSortEnum.BestMatch,
          page,
          limit: PAGE_SIZE,
        })
        .then((res) => res.data),
    staleTime: 30_000,
  })

  const joinMutation = useMutation({
    mutationFn: (guild: DtoGuildDiscovery) => guildApi.guildGuildIdJoinPost({ guildId: guildIdParam(guild) }),
    onSuccess: async (res, guild) => {
      await queryClient.invalidateQueries({ queryKey: ['guilds'] })
      toast.success(t('discovery.joined'))
      navigate(`/app/${String(res.data.id ?? guild.id)}`)
    },
    onError: () => {
      toast.error(t('discovery.joinFailed'))
    },
  })

  function updateSearch(next: { q?: string; tag?: string; page?: number }) {
    const params = new URLSearchParams()
    const nextQ = next.q ?? q
    const nextTag = next.tag ?? tag
    const nextPage = next.page ?? page
    if (nextQ.trim()) params.set('q', nextQ.trim())
    if (nextTag.trim()) params.set('tag', nextTag.trim())
    if (nextPage > 0) params.set('page', String(nextPage))
    setSearchParams(params)
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    updateSearch({ q: draft, page: 0 })
  }

  function goBack() {
    if (window.history.length > 1) {
      navigate(-1)
      return
    }
    navigate('/app')
  }

  const guilds = data?.guilds ?? []
  const pages = data?.pages ?? 0
  const activeJoinId = joinMutation.variables ? String(joinMutation.variables.id) : null

  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
          <header className="space-y-2">
            <div className="flex items-center gap-2">
              {isMobile ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="-ml-2 size-9 shrink-0"
                  onClick={goBack}
                  aria-label={t('common.back')}
                >
                  <ArrowLeft className="size-5" />
                </Button>
              ) : null}
              <h1 className="text-2xl font-semibold tracking-normal">{t('discovery.serversTitle')}</h1>
            </div>
            <p className="text-sm text-muted-foreground">{t('discovery.subtitle')}</p>
          </header>

          {isMobile ? (
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="secondary" className="gap-2" onClick={() => navigate('/app/discovery/servers')}>
                <Compass className="size-4" />
                {t('discovery.servers')}
              </Button>
              <Button type="button" variant="outline" className="gap-2" onClick={() => navigate('/app/discovery/bots')}>
                <Bot className="size-4" />
                {t('discovery.bots')}
              </Button>
            </div>
          ) : null}

          <div className="space-y-3">
            <form onSubmit={submitSearch} className="flex max-w-3xl gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={t('discovery.searchPlaceholder')}
                  className="pl-9"
                />
              </div>
              <Button type="submit" size="icon" aria-label={t('search.searchTitle')}>
                <Search className="size-4" />
              </Button>
            </form>

            <div className="flex flex-wrap gap-2">
              {QUICK_TAGS.map((item) => (
                <Button
                  key={item.tag}
                  type="button"
                  variant={tag === item.tag ? 'secondary' : 'outline'}
                  size="sm"
                  onClick={() => {
                    setDraft('')
                    updateSearch({ q: '', tag: item.tag, page: 0 })
                  }}
                  className={cn('h-8', tag === item.tag && 'border-primary/40')}
                >
                  {t(item.key)}
                </Button>
              ))}
            </div>
          </div>

          {isError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              {t('discovery.searchFailed')}
            </div>
          ) : null}

          {isLoading ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: PAGE_SIZE }).map((_, index) => (
                <Skeleton key={index} className="h-[214px] rounded-lg" />
              ))}
            </div>
          ) : guilds.length > 0 ? (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {guilds.map((guild) => (
                  <GuildDiscoveryCard
                    key={String(guild.id)}
                    guild={guild}
                    joining={joinMutation.isPending && activeJoinId === String(guild.id)}
                    onJoin={(selectedGuild) => joinMutation.mutate(selectedGuild)}
                  />
                ))}
              </div>

              {pages > 1 ? (
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 0}
                    onClick={() => updateSearch({ page: Math.max(0, page - 1) })}
                  >
                    {t('discovery.previousPage')}
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {t('search.pageOf', { page: page + 1, total: pages })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= pages - 1}
                    onClick={() => updateSearch({ page: page + 1 })}
                  >
                    {t('discovery.nextPage')}
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="flex min-h-[260px] flex-col items-center justify-center rounded-lg border border-dashed bg-muted/20 p-8 text-center">
              <Compass className="mb-3 size-9 text-muted-foreground" />
              <h2 className="text-base font-semibold">{t('discovery.noResults')}</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {t('discovery.noResultsDesc')}
              </p>
            </div>
          )}
      </div>
    </main>
  )
}
