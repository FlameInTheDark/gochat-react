import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CheckCircle2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { DtoGuild } from "@/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BotPermissionSummary } from "@/components/settings/BotPermissionPicker";
import { botsApi, type BotAuthorizationPreview } from "@/lib/botsApi";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/authStore";

function idString(value: string | number | undefined | null): string {
  return value == null ? "" : String(value);
}

function initials(name?: string): string {
  return (name ?? "B").trim().slice(0, 2).toUpperCase() || "B";
}

function guildName(guild: DtoGuild): string {
  return guild.name?.trim() || "Server";
}

function GuildIdentity({
  guild,
  compact,
}: {
  guild: DtoGuild;
  compact?: boolean;
}) {
  const name = guildName(guild);

  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.04] font-bold text-muted-foreground",
          compact ? "h-6 w-6 text-[10px]" : "h-9 w-9 text-xs",
        )}
      >
        {guild.icon?.url ? (
          <img
            src={guild.icon.url}
            alt={name}
            className="h-full w-full object-cover"
          />
        ) : (
          initials(name)
        )}
      </span>
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

export default function BotAuthorizePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const token = useAuthStore((state) => state.token);
  const [selectedGuildId, setSelectedGuildId] = useState("");
  const [authorizing, setAuthorizing] = useState(false);

  const grantToken = searchParams.get("grant_token") ?? undefined;
  const botUserId = searchParams.get("bot_user_id") ?? undefined;
  const requestedPermissions =
    Number(searchParams.get("permissions") ?? 0) || undefined;
  const canPreview = Boolean(token && (grantToken || botUserId));

  const {
    data: preview,
    isLoading: previewLoading,
    error: previewError,
  } = useQuery<BotAuthorizationPreview>({
    queryKey: [
      "bot-authorize-preview",
      grantToken ?? null,
      botUserId ?? null,
      requestedPermissions ?? null,
    ],
    queryFn: () =>
      botsApi.previewBotAuthorization({
        grant_token: grantToken,
        bot_user_id: botUserId,
        permissions: requestedPermissions,
      }),
    enabled: canPreview,
    staleTime: 30_000,
  });

  const { data: guilds = [], isLoading: guildsLoading } = useQuery<DtoGuild[]>({
    queryKey: ["bot-authorize-guilds"],
    queryFn: botsApi.listBotAuthorizationGuilds,
    enabled: Boolean(token),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (selectedGuildId || guilds.length === 0) return;
    setSelectedGuildId(idString(guilds[0]?.id));
  }, [guilds, selectedGuildId]);

  const selectedGuild = useMemo(
    () =>
      guilds.find((guild) => idString(guild.id) === selectedGuildId) ?? null,
    [guilds, selectedGuildId],
  );

  async function handleAuthorize() {
    if (!preview || !selectedGuildId || authorizing) return;
    setAuthorizing(true);
    try {
      await botsApi.installGuildBot(selectedGuildId, {
        grant_token: grantToken,
        bot_user_id: grantToken ? undefined : preview.bot.bot_user_id,
        granted_permissions: preview.requested_permissions,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["guilds"] }),
        queryClient.invalidateQueries({
          queryKey: ["guild-bots", selectedGuildId],
        }),
      ]);
      toast.success("Bot added");
      navigate(`/app/${selectedGuildId}`);
    } catch {
      toast.error("Failed to authorize bot");
    } finally {
      setAuthorizing(false);
    }
  }

  if (!token) {
    const next = `/bot/authorize?${searchParams.toString()}`;
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-background px-4">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center shadow-lg">
          <Bot className="mx-auto h-10 w-10 text-primary" />
          <h1 className="mt-4 text-xl font-bold">Authorize bot</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to choose a server.
          </p>
          <Button
            className="mt-6 w-full"
            onClick={() => navigate(`/?next=${encodeURIComponent(next)}`)}
          >
            Sign in
          </Button>
        </div>
      </div>
    );
  }

  const botName = preview?.bot.user?.name ?? "Bot";

  return (
    <div className="flex min-h-screen w-full items-start justify-center overflow-y-auto bg-background px-4 py-8 md:items-center">
      <div className="w-full max-w-3xl overflow-hidden rounded-lg border border-border bg-card shadow-lg">
        <div className="border-b border-border p-6">
          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16 text-xl">
              <AvatarImage
                src={preview?.bot.user?.avatar?.url}
                alt={botName}
                className="object-cover"
              />
              <AvatarFallback className="bg-primary text-primary-foreground font-bold">
                {initials(botName)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <ShieldCheck className="h-4 w-4" />
                Bot authorization
              </p>
              <h1 className="mt-1 truncate text-2xl font-bold">{botName}</h1>
              {preview?.bot.description && (
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {preview.bot.description}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="grid gap-0 md:grid-cols-[minmax(0,1fr)_300px]">
          <div className="border-b border-border p-6 md:border-b-0 md:border-r">
            {previewLoading ? (
              <p className="text-sm text-muted-foreground">Loading bot...</p>
            ) : previewError || !preview ? (
              <p className="text-sm text-destructive">
                Authorization link is invalid or expired.
              </p>
            ) : (
              <BotPermissionSummary value={preview.requested_permissions} />
            )}
          </div>

          <div className="space-y-4 p-6">
            <div className="space-y-2">
              <p className="text-sm font-medium">Server</p>
              <Select
                value={selectedGuildId}
                onValueChange={setSelectedGuildId}
                disabled={guildsLoading || guilds.length === 0}
              >
                <SelectTrigger className="w-full">
                  {selectedGuild ? (
                    <SelectValue asChild>
                      <GuildIdentity guild={selectedGuild} compact />
                    </SelectValue>
                  ) : (
                    <SelectValue
                      placeholder={
                        guildsLoading ? "Loading servers..." : "Select server"
                      }
                    />
                  )}
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {guilds.map((guild) => (
                    <SelectItem
                      key={idString(guild.id)}
                      value={idString(guild.id)}
                    >
                      <GuildIdentity guild={guild} compact />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!guildsLoading && guilds.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No servers available.
                </p>
              )}
            </div>

            {selectedGuild && (
              <div className="rounded-md border border-border bg-background/50 p-3">
                <GuildIdentity guild={selectedGuild} />
              </div>
            )}

            <Button
              className="w-full gap-2"
              disabled={!preview || !selectedGuildId || authorizing}
              onClick={() => void handleAuthorize()}
            >
              <CheckCircle2 className="h-4 w-4" />
              {authorizing ? "Authorizing..." : "Authorize"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => navigate("/app")}
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
