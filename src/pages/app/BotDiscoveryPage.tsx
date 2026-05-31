import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, Compass, Download, Search, Server, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { DtoGuild } from "@/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { BotPermissionSummary } from "@/components/settings/BotPermissionPicker";
import {
  botsApi,
  type BotDiscovery,
  type Snowflake,
} from "@/lib/botsApi";
import { cn } from "@/lib/utils";
import { useClientMode } from "@/hooks/useClientMode";

const PAGE_SIZE = 16;

const QUICK_TAGS = [
  { key: "discovery.botQuickModeration", tag: "moderation" },
  { key: "discovery.botQuickUtility", tag: "utility" },
  { key: "discovery.botQuickMusic", tag: "music" },
  { key: "discovery.botQuickAi", tag: "ai" },
  { key: "discovery.botQuickGames", tag: "games" },
  { key: "discovery.botQuickTools", tag: "tools" },
] as const;

function parsePage(value: string | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function idString(value: Snowflake | undefined | null): string {
  return value == null ? "" : String(value);
}

function initials(name?: string): string {
  return (name ?? "B").trim().slice(0, 2).toUpperCase() || "B";
}

function botName(bot: BotDiscovery, fallback: string): string {
  return bot.user?.name?.trim() || fallback;
}

function guildName(guild: DtoGuild, fallback: string): string {
  return guild.name?.trim() || fallback;
}

function formatInstalls(t: ReturnType<typeof useTranslation>["t"], count: number): string {
  return t(count === 1 ? "discovery.botInstalls" : "discovery.botInstallsPlural", { count });
}

function BotDiscoveryCard({
  bot,
  onInstall,
}: {
  bot: BotDiscovery;
  onInstall: (bot: BotDiscovery) => void;
}) {
  const { t } = useTranslation();
  const name = botName(bot, t("discovery.botFallbackName"));
  const description = bot.description?.trim();
  const installsCount = bot.installs_count ?? 0;

  return (
    <article className="min-h-[238px] rounded-lg border bg-card p-4 shadow-sm transition-colors hover:border-primary/50">
      <div className="flex h-full flex-col gap-3">
        <div className="flex items-start gap-3">
          <Avatar className="size-14 rounded-lg">
            <AvatarImage src={bot.user?.avatar?.url} alt={name} className="object-cover" />
            <AvatarFallback className="rounded-lg text-base font-semibold">
              {initials(name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold leading-6">{name}</h2>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Download className="size-3.5" />
              <span>{formatInstalls(t, installsCount)}</span>
            </div>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
            <Bot className="size-3" />
            {t("discovery.botBadge")}
          </span>
        </div>

        <p className="min-h-[40px] overflow-hidden text-sm leading-5 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
          {description || "\u00a0"}
        </p>

        <div className="flex min-h-6 flex-wrap gap-1.5 overflow-hidden">
          {(bot.tags ?? []).slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="max-w-full truncate rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
              aria-label={tag}
            >
              {tag}
            </span>
          ))}
        </div>

        <Button className="mt-auto w-full gap-2" size="sm" onClick={() => onInstall(bot)}>
          <Server className="size-4" />
          {t("discovery.addBot")}
        </Button>
      </div>
    </article>
  );
}

function GuildIdentity({ guild }: { guild: DtoGuild }) {
  const { t } = useTranslation();
  const name = guildName(guild, t("discovery.serverFallbackName"));
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted text-[10px] font-bold text-muted-foreground">
        {guild.icon?.url ? (
          <img src={guild.icon.url} alt={name} className="h-full w-full object-cover" />
        ) : (
          initials(name)
        )}
      </span>
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

function BotInstallDialog({
  bot,
  onClose,
}: {
  bot: BotDiscovery | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const open = bot != null;
  const defaultPermissions = Number(bot?.default_permissions ?? 0);
  const [selectedGuildId, setSelectedGuildId] = useState("");

  const { data: guilds = [], isLoading: guildsLoading } = useQuery<DtoGuild[]>({
    queryKey: ["bot-authorize-guilds"],
    queryFn: botsApi.listBotAuthorizationGuilds,
    enabled: open,
    staleTime: 30_000,
  });

  const effectiveSelectedGuildId = selectedGuildId || idString(guilds[0]?.id);

  const selectedGuild = useMemo(
    () => guilds.find((guild) => idString(guild.id) === effectiveSelectedGuildId) ?? null,
    [effectiveSelectedGuildId, guilds],
  );

  const installMutation = useMutation({
    mutationFn: async () => {
      if (!bot || !effectiveSelectedGuildId) throw new Error("missing bot or guild");
      return botsApi.installGuildBot(effectiveSelectedGuildId, {
        bot_user_id: bot.bot_user_id,
        granted_permissions: defaultPermissions,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["botDiscovery"] }),
        queryClient.invalidateQueries({ queryKey: ["guilds"] }),
        queryClient.invalidateQueries({ queryKey: ["guild-bots", effectiveSelectedGuildId] }),
      ]);
      toast.success(t("discovery.botAdded"));
      onClose();
    },
    onError: () => {
      toast.error(t("discovery.botAddFailed"));
    },
  });

  const name = bot ? botName(bot, t("discovery.botFallbackName")) : "";

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("discovery.addBotTitle", { name })}</DialogTitle>
          <DialogDescription>{t("discovery.addBotDesc")}</DialogDescription>
        </DialogHeader>

        {bot ? (
          <div className="space-y-4">
            <BotPermissionSummary
              value={defaultPermissions}
              listClassName="max-h-48 sm:max-h-56"
            />

            <div className="space-y-2">
              <p className="text-sm font-medium">{t("discovery.serverLabel")}</p>
              <Select
                value={effectiveSelectedGuildId}
                onValueChange={setSelectedGuildId}
                disabled={guildsLoading || guilds.length === 0}
              >
                <SelectTrigger className="w-full">
                  {selectedGuild ? (
                    <SelectValue asChild>
                      <GuildIdentity guild={selectedGuild} />
                    </SelectValue>
                  ) : (
                    <SelectValue
                      placeholder={
                        guildsLoading
                          ? t("discovery.loadingServers")
                          : t("discovery.selectServer")
                      }
                    />
                  )}
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {guilds.map((guild) => (
                    <SelectItem key={idString(guild.id)} value={idString(guild.id)}>
                      <GuildIdentity guild={guild} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!guildsLoading && guilds.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("discovery.noBotServers")}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!bot || !effectiveSelectedGuildId || installMutation.isPending}
            onClick={() => installMutation.mutate()}
          >
            {installMutation.isPending ? t("discovery.addingBot") : t("discovery.addBot")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function BotDiscoveryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useClientMode() === "mobile";
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q")?.trim() ?? "";
  const tag = searchParams.get("tag")?.trim() ?? "";
  const page = parsePage(searchParams.get("page"));
  const [draft, setDraft] = useState(q);
  const [installBot, setInstallBot] = useState<BotDiscovery | null>(null);

  useEffect(() => {
    setDraft(q);
  }, [q]);

  const queryKey = useMemo(() => ["botDiscovery", q, tag, page] as const, [q, tag, page]);
  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () =>
      botsApi.searchBots({
        q: q || undefined,
        tags: tag || undefined,
        sort: "best_match",
        page,
        limit: PAGE_SIZE,
      }),
    staleTime: 30_000,
  });

  function updateSearch(next: { q?: string; tag?: string; page?: number }) {
    const params = new URLSearchParams();
    const nextQ = next.q ?? q;
    const nextTag = next.tag ?? tag;
    const nextPage = next.page ?? page;
    if (nextQ.trim()) params.set("q", nextQ.trim());
    if (nextTag.trim()) params.set("tag", nextTag.trim());
    if (nextPage > 0) params.set("page", String(nextPage));
    setSearchParams(params);
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateSearch({ q: draft, page: 0 });
  }

  function goBack() {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate("/app");
  }

  const bots = data?.bots ?? [];
  const pages = data?.pages ?? 0;

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
                aria-label={t("common.back")}
              >
                <ArrowLeft className="size-5" />
              </Button>
            ) : null}
            <h1 className="text-2xl font-semibold tracking-normal">{t("discovery.botsTitle")}</h1>
          </div>
          <p className="text-sm text-muted-foreground">{t("discovery.botsSubtitle")}</p>
        </header>

        {isMobile ? (
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" className="gap-2" onClick={() => navigate("/app/discovery/servers")}>
              <Compass className="size-4" />
              {t("discovery.servers")}
            </Button>
            <Button type="button" variant="secondary" className="gap-2" onClick={() => navigate("/app/discovery/bots")}>
              <Bot className="size-4" />
              {t("discovery.bots")}
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
                placeholder={t("discovery.botSearchPlaceholder")}
                className="pl-9"
              />
            </div>
            <Button type="submit" size="icon" aria-label={t("search.searchTitle")}>
              <Search className="size-4" />
            </Button>
          </form>

          <div className="flex flex-wrap gap-2">
            {QUICK_TAGS.map((item) => (
              <Button
                key={item.tag}
                type="button"
                variant={tag === item.tag ? "secondary" : "outline"}
                size="sm"
                onClick={() => {
                  const nextTag = tag === item.tag ? "" : item.tag;
                  setDraft("");
                  updateSearch({ q: "", tag: nextTag, page: 0 });
                }}
                className={cn("h-8", tag === item.tag && "border-primary/40")}
              >
                {t(item.key)}
              </Button>
            ))}
            {tag ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => updateSearch({ tag: "", page: 0 })}
                aria-label={tag}
              >
                {tag}
                <X className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </div>

        {isError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            {t("discovery.botSearchFailed")}
          </div>
        ) : null}

        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: PAGE_SIZE }).map((_, index) => (
              <Skeleton key={index} className="h-[238px] rounded-lg" />
            ))}
          </div>
        ) : bots.length > 0 ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {bots.map((bot) => (
                <BotDiscoveryCard
                  key={idString(bot.bot_user_id)}
                  bot={bot}
                  onInstall={setInstallBot}
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
                  {t("discovery.previousPage")}
                </Button>
                <span className="text-sm text-muted-foreground">
                  {t("search.pageOf", { page: page + 1, total: pages })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= pages - 1}
                  onClick={() => updateSearch({ page: page + 1 })}
                >
                  {t("discovery.nextPage")}
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex min-h-[260px] flex-col items-center justify-center rounded-lg border border-dashed bg-muted/20 p-8 text-center">
            <Compass className="mb-3 size-9 text-muted-foreground" />
            <h2 className="text-base font-semibold">{t("discovery.noBots")}</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              {t("discovery.noBotsDesc")}
            </p>
          </div>
        )}
      </div>

      <BotInstallDialog
        key={installBot ? idString(installBot.bot_user_id) : "empty"}
        bot={installBot}
        onClose={() => setInstallBot(null)}
      />
    </main>
  );
}
