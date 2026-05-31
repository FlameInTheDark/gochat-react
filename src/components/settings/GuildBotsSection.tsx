import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { DtoRole } from "@/client";
import { BotPermissionSummary } from "@/components/settings/BotPermissionPicker";
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
import { botsApi, type InstalledBot, type Snowflake } from "@/lib/botsApi";

function initials(name?: string): string {
  return (name ?? "B").trim().slice(0, 2).toUpperCase() || "B";
}

function idString(value: Snowflake | undefined): string {
  return value == null ? "" : String(value);
}

function formatDate(value: number | undefined, unknown: string): string {
  if (!value) return unknown;
  const date = new Date(value > 1_000_000_000_000 ? value : value * 1000);
  if (Number.isNaN(date.getTime())) return unknown;
  return date.toLocaleString();
}

function roleColor(value?: number): string | undefined {
  if (!value) return undefined;
  return `#${value.toString(16).padStart(6, "0").slice(-6)}`;
}

function roleIds(bot: InstalledBot): Snowflake[] {
  return bot.member?.roles ?? bot.roles ?? [];
}

function botAvatarUrl(bot: InstalledBot): string | undefined {
  return bot.member?.user?.avatar?.url ?? bot.user?.avatar?.url;
}

function botName(bot: InstalledBot, fallback: string): string {
  return bot.member?.user?.name ?? bot.user?.name ?? fallback;
}

export default function GuildBotsSection({ guildId }: { guildId: Snowflake }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [removeTarget, setRemoveTarget] = useState<InstalledBot | null>(null);
  const [removingBotId, setRemovingBotId] = useState<string | null>(null);

  const { data: installedBots = [], isLoading } = useQuery<InstalledBot[]>({
    queryKey: ["guild-bots", idString(guildId)],
    queryFn: () => botsApi.listGuildBots(guildId),
    staleTime: 15_000,
  });

  const { data: roles = [] } = useQuery<DtoRole[]>({
    queryKey: ["guild-roles", idString(guildId)],
    queryFn: () => botsApi.listGuildRoles(guildId),
    staleTime: 30_000,
  });

  const rolesById = useMemo(() => {
    const next = new Map<string, DtoRole>();
    for (const role of roles) {
      next.set(idString(role.id), role);
    }
    return next;
  }, [roles]);

  async function handleRemoveConfirm() {
    if (!removeTarget) return;
    const bot = removeTarget;
    const botId = idString(bot.bot_user_id);
    if (!botId || removingBotId) return;

    setRemovingBotId(botId);
    try {
      await botsApi.removeGuildBot(guildId, bot.bot_user_id);
      await queryClient.invalidateQueries({
        queryKey: ["guild-bots", idString(guildId)],
      });
      toast.success(t("guildBots.removed"));
      setRemoveTarget(null);
    } catch {
      toast.error(t("guildBots.removeFailed"));
    } finally {
      setRemovingBotId(null);
    }
  }

  const removeTargetName = removeTarget
    ? botName(removeTarget, t("guildBots.unnamedBot"))
    : t("guildBots.unnamedBot");
  const removeTargetAvatarUrl = removeTarget ? botAvatarUrl(removeTarget) : undefined;
  const removeTargetId = idString(removeTarget?.bot_user_id);
  const removingTarget = removingBotId === removeTargetId;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">{t("guildBots.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("guildBots.subtitle")}
        </p>
      </div>

      {isLoading ? (
        <div className="rounded-lg border border-border bg-background/50 p-4 text-sm text-muted-foreground">
          {t("guildBots.loading")}
        </div>
      ) : installedBots.length === 0 ? (
        <div className="rounded-lg border border-border bg-background/50 p-6 text-sm text-muted-foreground">
          {t("guildBots.empty")}
        </div>
      ) : (
        <div className="space-y-3">
          {installedBots.map((bot) => {
            const botId = idString(bot.bot_user_id);
            const removing = removingBotId === botId;
            const name = botName(bot, t("guildBots.unnamedBot"));
            const avatarUrl = botAvatarUrl(bot);
            const assignedRoleIds = roleIds(bot);
            return (
              <div
                key={botId}
                className="rounded-lg border border-border bg-background/50 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar className="h-12 w-12">
                      <AvatarImage
                        src={avatarUrl}
                        alt={name}
                        className="object-cover"
                      />
                      <AvatarFallback className="bg-primary text-primary-foreground font-bold">
                        {initials(name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold">{name}</p>
                        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          <Bot className="h-3 w-3" />
                          {t("guildBots.botBadge")}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("guildBots.idLabel", { id: botId })}
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="gap-2"
                    disabled={removing}
                    onClick={() => setRemoveTarget(bot)}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t("guildBots.remove")}
                  </Button>
                </div>
                <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(220px,280px)]">
                  <BotPermissionSummary value={bot.granted_permissions ?? 0} />
                  <div className="space-y-3">
                    <div>
                      <p className="text-sm font-medium">{t("guildBots.roles")}</p>
                      <RoleBadges
                        roleIds={assignedRoleIds}
                        rolesById={rolesById}
                        noRolesLabel={t("guildBots.noRoles")}
                        roleFallback={(id) => t("guildBots.roleFallback", { id })}
                      />
                    </div>
                    <InfoTile
                      label={t("guildBots.installed")}
                      value={formatDate(bot.created_at, t("guildBots.unknown"))}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={removeTarget != null}
        onOpenChange={(open) => {
          if (!open && !removingBotId) setRemoveTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("guildBots.removeTitle")}</DialogTitle>
            <DialogDescription>
              {t("guildBots.removeDesc")}
            </DialogDescription>
          </DialogHeader>

          {removeTarget ? (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 p-3">
              <Avatar className="h-10 w-10">
                <AvatarImage
                  src={removeTargetAvatarUrl}
                  alt={removeTargetName}
                  className="object-cover"
                />
                <AvatarFallback className="bg-primary text-primary-foreground font-bold">
                  {initials(removeTargetName)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{removeTargetName}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {t("guildBots.idLabel", { id: removeTargetId })}
                </p>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={removingTarget}
              onClick={() => setRemoveTarget(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!removeTarget || removingTarget}
              onClick={() => void handleRemoveConfirm()}
            >
              {removingTarget
                ? t("guildBots.removing")
                : t("guildBots.removeConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RoleBadges({
  roleIds,
  rolesById,
  noRolesLabel,
  roleFallback,
}: {
  roleIds: Snowflake[];
  rolesById: Map<string, DtoRole>;
  noRolesLabel: string;
  roleFallback: (id: string) => string;
}) {
  if (roleIds.length === 0) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">{noRolesLabel}</p>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {roleIds.map((roleId) => {
        const role = rolesById.get(idString(roleId));
        const color = roleColor(role?.color);
        const label = role?.name ?? roleFallback(idString(roleId));
        return (
          <span
            key={idString(roleId)}
            className="inline-flex max-w-full items-center rounded-md border border-border bg-muted/20 px-2 py-1 text-xs font-medium"
            style={color ? { borderColor: color, color } : undefined}
            title={label}
          >
            <span className="min-w-0 truncate">{label}</span>
          </span>
        );
      })}
    </div>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 truncate text-sm font-medium">{value}</p>
    </div>
  );
}
