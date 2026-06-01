import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { PermissionBits } from "@/lib/permissions";
import { cn } from "@/lib/utils";

interface PermissionDef {
  bit: number;
  labelKey: string;
  descKey: string;
  danger?: boolean;
}

interface PermissionGroup {
  titleKey: string;
  permissions: PermissionDef[];
}

const GROUPS: PermissionGroup[] = [
  {
    titleKey: "serverSettings.permCategoryGeneral",
    permissions: [
      {
        bit: PermissionBits.VIEW_CHANNELS,
        labelKey: "serverSettings.permViewChannels",
        descKey: "serverSettings.permViewChannelsDesc",
      },
      {
        bit: PermissionBits.ADMINISTRATOR,
        labelKey: "serverSettings.permAdministrator",
        descKey: "serverSettings.permAdministratorDesc",
        danger: true,
      },
      {
        bit: PermissionBits.MANAGE_SERVER,
        labelKey: "serverSettings.permManageServer",
        descKey: "serverSettings.permManageServerDesc",
      },
      {
        bit: PermissionBits.MANAGE_ROLES,
        labelKey: "serverSettings.permManageRoles",
        descKey: "serverSettings.permManageRolesDesc",
        danger: true,
      },
      {
        bit: PermissionBits.MANAGE_CHANNELS,
        labelKey: "serverSettings.permManageChannels",
        descKey: "serverSettings.permManageChannelsDesc",
      },
      {
        bit: PermissionBits.VIEW_AUDIT_LOG,
        labelKey: "serverSettings.permViewAuditLog",
        descKey: "serverSettings.permViewAuditLogDesc",
      },
      {
        bit: PermissionBits.CREATE_INVITES,
        labelKey: "serverSettings.permCreateInvites",
        descKey: "serverSettings.permCreateInvitesDesc",
      },
    ],
  },
  {
    titleKey: "serverSettings.permCategoryText",
    permissions: [
      {
        bit: PermissionBits.READ_MESSAGE_HISTORY,
        labelKey: "serverSettings.permReadHistory",
        descKey: "serverSettings.permReadHistoryDesc",
      },
      {
        bit: PermissionBits.SEND_MESSAGES,
        labelKey: "serverSettings.permSendMessages",
        descKey: "serverSettings.permSendMessagesDesc",
      },
      {
        bit: PermissionBits.USE_APPLICATION_COMMANDS,
        labelKey: "serverSettings.permUseApplicationCommands",
        descKey: "serverSettings.permUseApplicationCommandsDesc",
      },
      {
        bit: PermissionBits.SEND_MESSAGES_IN_THREADS,
        labelKey: "serverSettings.permSendInThreads",
        descKey: "serverSettings.permSendInThreadsDesc",
      },
      {
        bit: PermissionBits.CREATE_THREADS,
        labelKey: "serverSettings.permCreateThreads",
        descKey: "serverSettings.permCreateThreadsDesc",
      },
      {
        bit: PermissionBits.ATTACH_FILES,
        labelKey: "serverSettings.permAttachFiles",
        descKey: "serverSettings.permAttachFilesDesc",
      },
      {
        bit: PermissionBits.ADD_REACTIONS,
        labelKey: "serverSettings.permAddReactions",
        descKey: "serverSettings.permAddReactionsDesc",
      },
      {
        bit: PermissionBits.MENTION_ROLES,
        labelKey: "serverSettings.permMentionRoles",
        descKey: "serverSettings.permMentionRolesDesc",
      },
      {
        bit: PermissionBits.MANAGE_MESSAGES,
        labelKey: "serverSettings.permManageMessages",
        descKey: "serverSettings.permManageMessagesDesc",
        danger: true,
      },
      {
        bit: PermissionBits.MANAGE_THREADS,
        labelKey: "serverSettings.permManageThreads",
        descKey: "serverSettings.permManageThreadsDesc",
      },
    ],
  },
  {
    titleKey: "serverSettings.permCategoryMembership",
    permissions: [
      {
        bit: PermissionBits.KICK_MEMBERS,
        labelKey: "serverSettings.permKickMembers",
        descKey: "serverSettings.permKickMembersDesc",
        danger: true,
      },
      {
        bit: PermissionBits.BAN_MEMBERS,
        labelKey: "serverSettings.permBanMembers",
        descKey: "serverSettings.permBanMembersDesc",
        danger: true,
      },
      {
        bit: PermissionBits.TIMEOUT_MEMBERS,
        labelKey: "serverSettings.permTimeoutMembers",
        descKey: "serverSettings.permTimeoutMembersDesc",
      },
      {
        bit: PermissionBits.CHANGE_NICKNAME,
        labelKey: "serverSettings.permChangeNickname",
        descKey: "serverSettings.permChangeNicknameDesc",
      },
      {
        bit: PermissionBits.MANAGE_NICKNAMES,
        labelKey: "serverSettings.permManageNicknames",
        descKey: "serverSettings.permManageNicknamesDesc",
      },
    ],
  },
  {
    titleKey: "serverSettings.permCategoryVoice",
    permissions: [
      {
        bit: PermissionBits.CONNECT,
        labelKey: "serverSettings.permConnect",
        descKey: "serverSettings.permConnectDesc",
      },
      {
        bit: PermissionBits.SPEAK,
        labelKey: "serverSettings.permSpeak",
        descKey: "serverSettings.permSpeakDesc",
      },
      {
        bit: PermissionBits.VIDEO,
        labelKey: "serverSettings.permVideo",
        descKey: "serverSettings.permVideoDesc",
      },
      {
        bit: PermissionBits.MUTE_MEMBERS,
        labelKey: "serverSettings.permMuteMembers",
        descKey: "serverSettings.permMuteMembersDesc",
      },
      {
        bit: PermissionBits.DEAFEN_MEMBERS,
        labelKey: "serverSettings.permDeafenMembers",
        descKey: "serverSettings.permDeafenMembersDesc",
      },
      {
        bit: PermissionBits.MOVE_MEMBERS,
        labelKey: "serverSettings.permMoveMembers",
        descKey: "serverSettings.permMoveMembersDesc",
      },
    ],
  },
  {
    titleKey: "serverSettings.permCategoryExpressions",
    permissions: [
      {
        bit: PermissionBits.CREATE_EXPRESSIONS,
        labelKey: "serverSettings.permCreateExpressions",
        descKey: "serverSettings.permCreateExpressionsDesc",
      },
      {
        bit: PermissionBits.MANAGE_EXPRESSIONS,
        labelKey: "serverSettings.permManageExpressions",
        descKey: "serverSettings.permManageExpressionsDesc",
      },
    ],
  },
];

export const BOT_PERMISSION_BASELINE =
  (2 ** PermissionBits.VIEW_CHANNELS) |
  (2 ** PermissionBits.READ_MESSAGE_HISTORY) |
  (2 ** PermissionBits.SEND_MESSAGES) |
  (2 ** PermissionBits.USE_APPLICATION_COMMANDS) |
  (2 ** PermissionBits.ADD_REACTIONS);

function permissionValue(bit: number): number {
  return 2 ** bit;
}

function hasPermission(mask: number, bit: number): boolean {
  return Math.floor(mask / permissionValue(bit)) % 2 === 1;
}

function setPermission(mask: number, bit: number, enabled: boolean): number {
  const value = permissionValue(bit);
  const current = hasPermission(mask, bit);
  if (enabled === current) return mask;
  return enabled ? mask + value : mask - value;
}

export function BotPermissionSummary({
  value,
  className,
  listClassName,
}: {
  value: number;
  className?: string;
  listClassName?: string;
}) {
  const { t } = useTranslation();
  const selectedGroups = useMemo(
    () =>
      GROUPS.map((group) => ({
        ...group,
        permissions: group.permissions.filter((permission) =>
          hasPermission(value, permission.bit),
        ),
      })).filter((group) => group.permissions.length > 0),
    [value],
  );
  const selectedCount = selectedGroups.reduce(
    (count, group) => count + group.permissions.length,
    0,
  );

  return (
    <div className={cn("space-y-3", className)}>
      <div>
        <p className="text-sm font-medium">{t("botPermissions.title")}</p>
      </div>

      <div
        className={cn(
          "max-h-[320px] overflow-y-auto rounded-lg border border-border bg-background/50",
          listClassName,
        )}
      >
        {selectedCount === 0 ? (
          <p className="px-3 py-3 text-sm text-muted-foreground">
            {t("botPermissions.noneSelected")}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {selectedGroups.map((group) => (
              <div key={group.titleKey}>
                <div className="bg-muted/30 px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t(group.titleKey)}
                  </p>
                </div>
                <div className="divide-y divide-border">
                  {group.permissions.map((permission) => (
                    <div
                      key={permission.bit}
                      className="flex items-center gap-2 px-3 py-2"
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                        <Check className="h-3 w-3" />
                      </span>
                      <span
                        className={cn(
                          "min-w-0 truncate text-sm font-medium",
                          permission.danger && "text-destructive",
                        )}
                      >
                        {t(permission.labelKey)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function BotPermissionPicker({
  value,
  onChange,
  disabled,
  compact,
  availablePermissions,
  className,
}: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  compact?: boolean;
  availablePermissions?: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const selectedCount = useMemo(
    () =>
      GROUPS.reduce(
        (count, group) =>
          count +
          group.permissions.filter((permission) =>
            hasPermission(value, permission.bit),
          ).length,
        0,
    ),
    [value],
  );

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{t("botPermissions.title")}</p>
          <p className="text-xs text-muted-foreground">
            {t("botPermissions.selectedSummary", { count: selectedCount, value })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
            disabled={disabled || value === 0}
            onClick={() => onChange(0)}
          >
            {t("botPermissions.clear")}
          </button>
          <button
            type="button"
            className="text-xs font-medium text-primary hover:text-primary/80 disabled:opacity-50"
            disabled={disabled}
            onClick={() =>
              onChange(
                availablePermissions == null
                  ? BOT_PERMISSION_BASELINE
                  : BOT_PERMISSION_BASELINE & availablePermissions,
              )
            }
          >
            {t("botPermissions.baseline")}
          </button>
        </div>
      </div>

      <div className={cn("space-y-3", compact && "space-y-2")}>
        {GROUPS.map((group) => (
          <div
            key={group.titleKey}
            className="rounded-lg border border-border bg-background/50"
          >
            <div className="px-3 py-2 border-b border-border">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t(group.titleKey)}
              </p>
            </div>
            <div className="divide-y divide-border">
              {group.permissions.map((permission) => {
                const enabled = hasPermission(value, permission.bit);
                const available =
                  availablePermissions == null ||
                  hasPermission(availablePermissions, permission.bit);
                return (
                  <button
                    key={permission.bit}
                    type="button"
                    disabled={disabled || !available}
                    className={cn(
                      "w-full flex items-start gap-3 px-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      compact ? "py-2" : "py-3",
                      enabled ? "bg-primary/5" : available && "hover:bg-accent/40",
                    )}
                    onClick={() =>
                      onChange(setPermission(value, permission.bit, !enabled))
                    }
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors",
                        enabled
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background",
                      )}
                    >
                      {enabled && <Check className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block text-sm font-medium",
                          permission.danger && enabled && "text-destructive",
                        )}
                      >
                        {t(permission.labelKey)}
                      </span>
                      {!compact && (
                        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                          {t(permission.descKey)}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
