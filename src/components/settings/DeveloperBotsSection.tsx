import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Bot,
  Camera,
  Copy,
  Globe,
  ImagePlus,
  KeyRound,
  Link2,
  Loader2,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { uploadApi, uploadProfileBanner } from "@/api/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  BOT_PERMISSION_BASELINE,
  BotPermissionPicker,
} from "@/components/settings/BotPermissionPicker";
import {
  botsApi,
  buildBotInstallUrl,
  type BotInstallGrant,
  type BotRuntimeToken,
  type DeveloperBot,
  type Snowflake,
} from "@/lib/botsApi";
import {
  applicationCommandsApi,
  type ApplicationCommand,
} from "@/lib/applicationCommandsApi";
import { cn } from "@/lib/utils";

const DEFAULT_BANNER_COLOR = "#5865f2";
const DEFAULT_PANEL_COLOR = "#2b2d31";
const INSTALL_GRANT_DEFAULT_TTL = 60 * 60 * 24 * 7;
const INSTALL_GRANT_DEFAULT_MAX_USES = 1;
const BOT_AVATAR_MAX_SIZE = 250 * 1024;
const BOT_BANNER_MAX_SIZE = 10 * 1024 * 1024;
const MAX_DISCOVERY_TAGS = 10;
const DISCOVERY_TAG_PATTERN = /^[a-z0-9_-]{2,32}$/;
type PermissionTab = "public" | "url";

function numToHex(value: number | undefined | null, fallback: string): string {
  if (value == null) return fallback;
  return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
}

function hexToNum(value: string): number {
  return parseInt(value.replace("#", ""), 16);
}

function initials(name?: string): string {
  return (name ?? "B").trim().slice(0, 2).toUpperCase() || "B";
}

function isActiveToken(token: BotRuntimeToken): boolean {
  return token.revoked_at == null || token.revoked_at === "";
}

function isActiveGrant(grant: BotInstallGrant): boolean {
  if (grant.revoked_at) return false;
  if (
    typeof grant.max_uses === "number" &&
    grant.max_uses > 0 &&
    grant.max_uses <= (grant.uses ?? 0)
  ) {
    return false;
  }
  if (!grant.expires_at) return true;
  return new Date(grant.expires_at).getTime() > Date.now();
}

type Translate = ReturnType<typeof useTranslation>["t"];

function formatDate(value: string | number | null | undefined, t: Translate): string {
  if (value == null || value === "") return t("developerBots.never");
  const date =
    typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return t("developerBots.unknown");
  return date.toLocaleString();
}

function idString(value: Snowflake | undefined): string {
  return value == null ? "" : String(value);
}

function editableApplicationCommand(command: ApplicationCommand) {
  return {
    type: command.type,
    name: command.name,
    description: command.description ?? "",
    options: command.options ?? [],
    default_member_permissions: command.default_member_permissions ?? null,
    contexts: command.contexts ?? [0, 1],
    integration_types: command.integration_types ?? [0],
    nsfw: Boolean(command.nsfw),
  };
}

function applicationCommandsJson(commands: ApplicationCommand[]): string {
  return JSON.stringify(commands.map(editableApplicationCommand), null, 2);
}

function normalizeDiscoveryTag(value: string): string {
  return value.trim().toLowerCase();
}

async function copyText(value: string, message: string) {
  await navigator.clipboard.writeText(value);
  toast.success(message);
}

export default function DeveloperBotsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [grantBusy, setGrantBusy] = useState(false);
  const [commandsBusy, setCommandsBusy] = useState(false);
  const [commandGuildId, setCommandGuildId] = useState("");
  const [commandsJson, setCommandsJson] = useState("[]");
  const [oneTimeToken, setOneTimeToken] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [permissionsTab, setPermissionsTab] = useState<PermissionTab>("public");
  const [grantUnlimitedUses, setGrantUnlimitedUses] = useState(true);
  const [form, setForm] = useState({
    name: "",
    bio: "",
    description: "",
    tags: [] as string[],
    public: false,
    disabled: false,
    defaultPermissions: BOT_PERMISSION_BASELINE,
    bannerColor: DEFAULT_BANNER_COLOR,
    panelColor: DEFAULT_PANEL_COLOR,
  });
  const [grantPermissions, setGrantPermissions] = useState(
    BOT_PERMISSION_BASELINE,
  );
  const [grantExpiresIn, setGrantExpiresIn] = useState(
    INSTALL_GRANT_DEFAULT_TTL,
  );
  const [grantMaxUses, setGrantMaxUses] = useState(
    INSTALL_GRANT_DEFAULT_MAX_USES,
  );

  const { data: bots = [], isLoading: botsLoading } = useQuery<DeveloperBot[]>({
    queryKey: ["developer-bots"],
    queryFn: botsApi.listDeveloperBots,
    staleTime: 30_000,
  });

  const selectedBot = useMemo(
    () =>
      bots.find((bot) => idString(bot.bot_user_id) === selectedBotId) ?? null,
    [bots, selectedBotId],
  );

  const selectedBotKey = selectedBotId ?? "none";
  const commandScopeGuildId = commandGuildId.trim() || undefined;

  const { data: tokens = [], isLoading: tokensLoading } = useQuery<
    BotRuntimeToken[]
  >({
    queryKey: ["developer-bot-tokens", selectedBotKey],
    queryFn: () => botsApi.listBotTokens(selectedBotKey),
    enabled: !!selectedBotId,
    staleTime: 15_000,
  });

  const { data: grants = [], isLoading: grantsLoading } = useQuery<
    BotInstallGrant[]
  >({
    queryKey: ["developer-bot-grants", selectedBotKey],
    queryFn: () => botsApi.listBotGrants(selectedBotKey),
    enabled: !!selectedBotId,
    staleTime: 15_000,
  });

  const { data: applicationCommands = [], isLoading: applicationCommandsLoading } =
    useQuery<ApplicationCommand[]>({
      queryKey: [
        "developer-bot-commands",
        selectedBotKey,
        commandScopeGuildId ?? "global",
      ],
      queryFn: () =>
        applicationCommandsApi.listDeveloperCommands(
          selectedBotKey,
          commandScopeGuildId,
        ),
      enabled: !!selectedBotId,
      staleTime: 15_000,
    });

  const activeTokens = useMemo(() => tokens.filter(isActiveToken), [tokens]);
  const latestActiveToken = activeTokens[0] ?? null;
  const activeGrants = useMemo(() => grants.filter(isActiveGrant), [grants]);

  useEffect(() => {
    if (
      selectedBotId &&
      !bots.some((bot) => idString(bot.bot_user_id) === selectedBotId)
    ) {
      setSelectedBotId(null);
    }
  }, [bots, selectedBotId]);

  useEffect(() => {
    if (!selectedBot) return;
    setForm({
      name: selectedBot.user?.name ?? "",
      bio: selectedBot.user?.bio ?? "",
      description: selectedBot.description ?? "",
      tags: selectedBot.tags ?? [],
      public: Boolean(selectedBot.public),
      disabled: Boolean(selectedBot.disabled),
      defaultPermissions: Number(
        selectedBot.default_permissions ?? BOT_PERMISSION_BASELINE,
      ),
      bannerColor: numToHex(
        selectedBot.user?.banner_color,
        DEFAULT_BANNER_COLOR,
      ),
      panelColor: numToHex(selectedBot.user?.panel_color, DEFAULT_PANEL_COLOR),
    });
    setGrantPermissions(
      Number(selectedBot.default_permissions ?? BOT_PERMISSION_BASELINE),
    );
    setTagDraft("");
    setOneTimeToken(null);
    setInstallUrl(null);
    setCommandGuildId("");
  }, [selectedBot]);

  useEffect(() => {
    if (!selectedBotId) {
      setCommandsJson("[]");
      return;
    }
    setCommandsJson(applicationCommandsJson(applicationCommands));
  }, [applicationCommands, selectedBotId, commandScopeGuildId]);

  async function handleCreateBot() {
    const name = createName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const bot = await botsApi.createDeveloperBot({
        name,
        description: "",
        public: false,
        default_permissions: BOT_PERMISSION_BASELINE,
      });
      setCreateName("");
      setSelectedBotId(idString(bot.bot_user_id));
      await queryClient.invalidateQueries({ queryKey: ["developer-bots"] });
      toast.success(t("developerBots.botCreated"));
    } catch {
      toast.error(t("developerBots.createFailed"));
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveBot() {
    if (!selectedBot) return;
    const name = form.name.trim();
    if (!name) {
      toast.error(t("developerBots.nameRequired"));
      return;
    }

    setSaving(true);
    try {
      await botsApi.updateDeveloperBot(selectedBot.bot_user_id, {
        name,
        bio: form.bio.trim(),
        description: form.description.trim(),
        tags: form.tags,
        public: form.public,
        disabled: form.disabled,
        default_permissions: form.defaultPermissions,
        banner_color: hexToNum(form.bannerColor),
        panel_color: hexToNum(form.panelColor),
      });
      await queryClient.invalidateQueries({ queryKey: ["developer-bots"] });
      toast.success(t("developerBots.botSaved"));
    } catch {
      toast.error(t("developerBots.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleAvatarFileSelected(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!selectedBot || !file) return;
    if (!file.type.startsWith("image/")) {
      toast.error(t("developerBots.avatarImageRequired"));
      return;
    }
    if (file.size > BOT_AVATAR_MAX_SIZE) {
      toast.error(t("developerBots.avatarTooLarge"));
      return;
    }

    setUploadingAvatar(true);
    try {
      const placeholder = await botsApi.createBotAvatarUpload(
        selectedBot.bot_user_id,
        {
          content_type: file.type || "application/octet-stream",
          file_size: file.size,
        },
      );
      await uploadApi.uploadAvatarsUserIdAvatarIdPost({
        userId: placeholder.user_id as unknown as number,
        avatarId: placeholder.id as unknown as number,
        file: file as unknown as number[],
      });
      await botsApi.updateDeveloperBot(selectedBot.bot_user_id, {
        avatar: placeholder.id,
      });
      await queryClient.invalidateQueries({ queryKey: ["developer-bots"] });
      toast.success(t("developerBots.avatarUpdated"));
    } catch {
      toast.error(t("developerBots.avatarUploadFailed"));
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function handleBannerFileSelected(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!selectedBot || !file) return;
    if (!file.type.startsWith("image/")) {
      toast.error(t("developerBots.bannerImageRequired"));
      return;
    }
    if (file.size > BOT_BANNER_MAX_SIZE) {
      toast.error(t("developerBots.bannerTooLarge"));
      return;
    }

    setUploadingBanner(true);
    try {
      const placeholder = await botsApi.createBotBannerUpload(
        selectedBot.bot_user_id,
        {
          content_type: file.type || "application/octet-stream",
          file_size: file.size,
        },
      );
      await uploadProfileBanner(
        String(placeholder.user_id),
        String(placeholder.id),
        file,
      );
      await botsApi.updateDeveloperBot(selectedBot.bot_user_id, {
        banner: placeholder.id,
      });
      await queryClient.invalidateQueries({ queryKey: ["developer-bots"] });
      toast.success(t("developerBots.bannerUpdated"));
    } catch {
      toast.error(t("developerBots.bannerUploadFailed"));
    } finally {
      setUploadingBanner(false);
    }
  }

  async function handleDeleteBot() {
    if (!selectedBot || deleting) return;
    const confirmed = window.confirm(
      t("developerBots.deleteConfirm", {
        name: selectedBot.user?.name ?? t("developerBots.unnamedBot"),
      }),
    );
    if (!confirmed) return;

    setDeleting(true);
    try {
      await botsApi.deleteDeveloperBot(selectedBot.bot_user_id);
      await queryClient.invalidateQueries({ queryKey: ["developer-bots"] });
      toast.success(t("developerBots.botDeleted"));
    } catch {
      toast.error(t("developerBots.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  async function handleGenerateToken() {
    if (!selectedBot || tokenBusy) return;
    setTokenBusy(true);
    try {
      const created = await botsApi.createBotToken(selectedBot.bot_user_id);
      const createdId = idString(created.token_data.id);
      await Promise.all(
        activeTokens
          .filter((token) => idString(token.id) !== createdId)
          .map((token) =>
            botsApi.revokeBotToken(selectedBot.bot_user_id, token.id),
          ),
      );
      setOneTimeToken(created.token);
      await queryClient.invalidateQueries({
        queryKey: ["developer-bot-tokens", selectedBotKey],
      });
      toast.success(
        activeTokens.length > 0
          ? t("developerBots.tokenRegenerated")
          : t("developerBots.tokenGenerated"),
      );
    } catch {
      toast.error(t("developerBots.tokenGenerateFailed"));
    } finally {
      setTokenBusy(false);
    }
  }

  async function handleRevokeToken(token: BotRuntimeToken) {
    if (!selectedBot || tokenBusy) return;
    setTokenBusy(true);
    try {
      await botsApi.revokeBotToken(selectedBot.bot_user_id, token.id);
      setOneTimeToken(null);
      await queryClient.invalidateQueries({
        queryKey: ["developer-bot-tokens", selectedBotKey],
      });
      toast.success(t("developerBots.tokenRevoked"));
    } catch {
      toast.error(t("developerBots.tokenRevokeFailed"));
    } finally {
      setTokenBusy(false);
    }
  }

  async function handleCreateGrant() {
    if (!selectedBot || grantBusy) return;
    setGrantBusy(true);
    try {
      const created = await botsApi.createBotGrant(selectedBot.bot_user_id, {
        requested_permissions: grantPermissions,
        expires_in_seconds: grantExpiresIn,
        max_uses: grantUnlimitedUses ? -1 : grantMaxUses,
      });
      const url = buildBotInstallUrl(created.token, grantPermissions);
      setInstallUrl(url);
      await queryClient.invalidateQueries({
        queryKey: ["developer-bot-grants", selectedBotKey],
      });
      toast.success(t("developerBots.installUrlGenerated"));
    } catch {
      toast.error(t("developerBots.installUrlGenerateFailed"));
    } finally {
      setGrantBusy(false);
    }
  }

  async function handleRevokeGrant(grant: BotInstallGrant) {
    if (!selectedBot || grantBusy) return;
    setGrantBusy(true);
    try {
      await botsApi.revokeBotGrant(selectedBot.bot_user_id, grant.id);
      await queryClient.invalidateQueries({
        queryKey: ["developer-bot-grants", selectedBotKey],
      });
      toast.success(t("developerBots.installGrantRevoked"));
    } catch {
      toast.error(t("developerBots.installGrantRevokeFailed"));
    } finally {
      setGrantBusy(false);
    }
  }

  async function handleSaveApplicationCommands() {
    if (!selectedBot || commandsBusy) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(commandsJson);
    } catch {
      toast.error(t("developerBots.applicationCommandJsonInvalid"));
      return;
    }
    if (!Array.isArray(parsed)) {
      toast.error(t("developerBots.applicationCommandJsonInvalid"));
      return;
    }

    setCommandsBusy(true);
    try {
      await applicationCommandsApi.bulkOverwriteDeveloperCommands(
        selectedBot.bot_user_id,
        parsed as Partial<ApplicationCommand>[],
        commandScopeGuildId,
      );
      await queryClient.invalidateQueries({
        queryKey: [
          "developer-bot-commands",
          selectedBotKey,
          commandScopeGuildId ?? "global",
        ],
      });
      toast.success(t("developerBots.applicationCommandsSaved"));
    } catch {
      toast.error(t("developerBots.applicationCommandsSaveFailed"));
    } finally {
      setCommandsBusy(false);
    }
  }

  function addDiscoveryTags(raw: string): boolean {
    const values = raw
      .split(",")
      .map(normalizeDiscoveryTag)
      .filter(Boolean);
    if (values.length === 0) return false;

    const invalid = values.filter((tag) => !DISCOVERY_TAG_PATTERN.test(tag));
    if (invalid.length > 0) {
      toast.error(t("developerBots.invalidTags", { tags: invalid.join(", ") }));
      return false;
    }

    let next = form.tags;
    for (const tag of values) {
      if (next.includes(tag)) continue;
      if (next.length >= MAX_DISCOVERY_TAGS) {
        toast.error(t("developerBots.maxTags", { count: MAX_DISCOVERY_TAGS }));
        break;
      }
      next = [...next, tag];
    }
    setForm((current) => ({ ...current, tags: next }));
    setTagDraft("");
    return true;
  }

  function removeDiscoveryTag(tag: string) {
    setForm((current) => ({
      ...current,
      tags: current.tags.filter((item) => item !== tag),
    }));
  }

  return (
    <div className="space-y-6">
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => void handleAvatarFileSelected(event)}
      />
      <input
        ref={bannerInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => void handleBannerFileSelected(event)}
      />
      <div className="flex items-center justify-between gap-3">
        {selectedBot ? (
          <div className="flex min-w-0 items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setSelectedBotId(null)}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <h2 className="truncate text-xl font-bold">
                {form.name || selectedBot.user?.name || t("developerBots.botSettingsFallback")}
              </h2>
            </div>
          </div>
        ) : (
          <div>
            <h2 className="text-xl font-bold">{t("developerBots.title")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("developerBots.subtitle")}
            </p>
          </div>
        )}
      </div>

      <div className={cn(selectedBot ? "space-y-5" : "max-w-2xl space-y-3")}>
        {!selectedBot && (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-background/50 p-3">
              <Label
                htmlFor="new-bot-name"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {t("developerBots.newBot")}
              </Label>
              <div className="mt-2 flex gap-2">
                <Input
                  id="new-bot-name"
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleCreateBot();
                  }}
                  placeholder={t("developerBots.botNamePlaceholder")}
                  maxLength={32}
                />
                <Button
                  type="button"
                  size="icon"
                  disabled={creating || !createName.trim()}
                  onClick={() => void handleCreateBot()}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="overflow-hidden rounded-lg border border-border bg-background/50">
              {botsLoading ? (
                <div className="p-4 text-sm text-muted-foreground">
                  {t("developerBots.loadingBots")}
                </div>
              ) : bots.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">
                  {t("developerBots.emptyBots")}
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {bots.map((bot) => {
                    const botId = idString(bot.bot_user_id);
                    const selected = botId === selectedBotId;
                    return (
                      <button
                        key={botId}
                        type="button"
                        onClick={() => setSelectedBotId(botId)}
                        className={cn(
                          "flex w-full items-center gap-3 px-3 py-3 text-left transition-colors",
                          selected
                            ? "bg-accent text-foreground"
                            : "hover:bg-accent/50 text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <Avatar className="h-9 w-9">
                          <AvatarImage
                            src={bot.user?.avatar?.url}
                            alt={bot.user?.name ?? ""}
                            className="object-cover"
                          />
                          <AvatarFallback className="bg-primary text-primary-foreground text-xs font-bold">
                            {initials(bot.user?.name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {bot.user?.name ?? t("developerBots.unnamedBot")}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                            <Bot className="h-3 w-3" />
                            {bot.public ? t("developerBots.publicStatus") : t("developerBots.privateStatus")}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {selectedBot && (
          <div className="space-y-5">
            <div className="rounded-lg border border-border bg-background/50 p-4">
              <div
                className="relative mb-4 h-36 overflow-hidden rounded-md border border-border bg-muted"
                style={{ backgroundColor: form.bannerColor }}
              >
                {selectedBot.user?.banner?.url && (
                  <img
                    src={selectedBot.user.banner.url}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="absolute bottom-3 right-3 gap-2"
                  disabled={uploadingBanner}
                  onClick={() => bannerInputRef.current?.click()}
                >
                  {uploadingBanner ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ImagePlus className="h-4 w-4" />
                  )}
                  {t("developerBots.banner")}
                </Button>
              </div>
              <div className="flex items-start gap-4">
                <button
                  type="button"
                  className="group relative h-16 w-16 shrink-0 rounded-full"
                  disabled={uploadingAvatar}
                  onClick={() => avatarInputRef.current?.click()}
                >
                  <Avatar className="h-16 w-16 text-2xl">
                    <AvatarImage
                      src={selectedBot.user?.avatar?.url}
                      alt={selectedBot.user?.name ?? ""}
                      className="object-cover"
                    />
                    <AvatarFallback className="bg-primary text-primary-foreground text-xl font-bold">
                      {initials(form.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-disabled:opacity-100">
                    {uploadingAvatar ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <Camera className="h-5 w-5" />
                    )}
                  </span>
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-lg font-semibold">
                      {form.name || t("developerBots.unnamedBot")}
                    </h3>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {t("developerBots.botBadge")}
                    </span>
                    {form.disabled && (
                      <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-destructive">
                        {t("developerBots.disabledBadge")}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("developerBots.idLabel", { id: idString(selectedBot.bot_user_id) })}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="gap-2"
                      disabled={saving}
                      onClick={() => void handleSaveBot()}
                    >
                      <Save className="h-4 w-4" />
                      {t("developerBots.save")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-2"
                      onClick={() =>
                        void copyText(
                          idString(selectedBot.bot_user_id),
                          t("developerBots.botIdCopied"),
                        )
                      }
                    >
                      <Copy className="h-4 w-4" />
                      {t("developerBots.copyId")}
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-background/50 p-4">
              <h3 className="text-base font-semibold">{t("developerBots.profile")}</h3>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="bot-name">{t("developerBots.botName")}</Label>
                  <Input
                    id="bot-name"
                    value={form.name}
                    maxLength={32}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bot-description">{t("developerBots.botDescription")}</Label>
                  <Input
                    id="bot-description"
                    value={form.description}
                    maxLength={160}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                  />
                </div>
              </div>
              <div className="mt-4 space-y-2">
                <Label htmlFor="bot-bio">{t("developerBots.profileBio")}</Label>
                <Textarea
                  id="bot-bio"
                  value={form.bio}
                  maxLength={190}
                  rows={3}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      bio: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="mt-4 space-y-2">
                <Label htmlFor="bot-tags">{t("developerBots.discoveryTags")}</Label>
                <div className="flex gap-2">
                  <Input
                    id="bot-tags"
                    value={tagDraft}
                    placeholder={t("developerBots.tagsPlaceholder")}
                    onChange={(event) => setTagDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      addDiscoveryTags(tagDraft);
                    }}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    disabled={!tagDraft.trim() || form.tags.length >= MAX_DISCOVERY_TAGS}
                    onClick={() => addDiscoveryTags(tagDraft)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("developerBots.tagsHint")}
                </p>
                {form.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {form.tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                      >
                        <span className="truncate">{tag}</span>
                        <button
                          type="button"
                          className="rounded-sm hover:text-foreground"
                          onClick={() => removeDiscoveryTag(tag)}
                          aria-label={t("developerBots.removeTag", { tag })}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <ColorInput
                  id="bot-banner-color"
                  label={t("developerBots.bannerColor")}
                  value={form.bannerColor}
                  onChange={(value) =>
                    setForm((current) => ({ ...current, bannerColor: value }))
                  }
                />
                <ColorInput
                  id="bot-panel-color"
                  label={t("developerBots.panelColor")}
                  value={form.panelColor}
                  onChange={(value) =>
                    setForm((current) => ({ ...current, panelColor: value }))
                  }
                />
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <ToggleRow
                  icon={<Globe className="h-4 w-4" />}
                  title={t("developerBots.publicDiscovery")}
                  description={t("developerBots.publicDiscoveryDesc")}
                  value={form.public}
                  onToggle={() =>
                    setForm((current) => ({
                      ...current,
                      public: !current.public,
                    }))
                  }
                />
                <ToggleRow
                  icon={<Bot className="h-4 w-4" />}
                  title={t("developerBots.runtimeDisabled")}
                  description={t("developerBots.runtimeDisabledDesc")}
                  value={form.disabled}
                  onToggle={() =>
                    setForm((current) => ({
                      ...current,
                      disabled: !current.disabled,
                    }))
                  }
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-background/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">{t("developerBots.runtimeToken")}</h3>
                  <p className="text-xs text-muted-foreground">
                    {tokensLoading
                      ? t("developerBots.checkingToken")
                      : latestActiveToken
                        ? t("developerBots.activeTokenPrefix", {
                            prefix:
                              latestActiveToken.token_prefix ??
                              t("developerBots.unknown"),
                          })
                        : t("developerBots.noActiveToken")}
                  </p>
                </div>
                <div className="flex gap-2">
                  {latestActiveToken && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={tokenBusy}
                      onClick={() => void handleRevokeToken(latestActiveToken)}
                    >
                      {t("developerBots.revoke")}
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    className="gap-2"
                    disabled={tokenBusy}
                    onClick={() => void handleGenerateToken()}
                  >
                    <KeyRound className="h-4 w-4" />
                    {latestActiveToken ? t("developerBots.regenerate") : t("developerBots.generate")}
                  </Button>
                </div>
              </div>
              {oneTimeToken && (
                <div className="mt-4 rounded-md border border-primary/30 bg-primary/5 p-3">
                  <div className="flex items-start gap-3">
                    <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{t("developerBots.tokenShownOnce")}</p>
                      <code className="mt-2 block overflow-x-auto rounded bg-background px-2 py-1.5 text-xs">
                        {oneTimeToken}
                      </code>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() =>
                        void copyText(oneTimeToken, t("developerBots.tokenCopied"))
                      }
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border bg-background/50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">
                    {t("developerBots.applicationCommands")}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {applicationCommandsLoading
                      ? t("developerBots.applicationCommandsLoading")
                      : commandScopeGuildId
                        ? t("developerBots.applicationCommandsCount", {
                            count: applicationCommands.length,
                          })
                        : `${t("developerBots.applicationCommandGlobalScope")} · ${t(
                            "developerBots.applicationCommandsCount",
                            { count: applicationCommands.length },
                          )}`}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="gap-2"
                  disabled={commandsBusy}
                  onClick={() => void handleSaveApplicationCommands()}
                >
                  {commandsBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  {t("developerBots.save")}
                </Button>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <div className="space-y-2">
                  <Label htmlFor="bot-command-guild">
                    {t("developerBots.applicationCommandGuildScope")}
                  </Label>
                  <Input
                    id="bot-command-guild"
                    value={commandGuildId}
                    placeholder={t(
                      "developerBots.applicationCommandGuildScopePlaceholder",
                    )}
                    onChange={(event) => setCommandGuildId(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bot-command-json">
                    {t("developerBots.applicationCommandJson")}
                  </Label>
                  <Textarea
                    id="bot-command-json"
                    value={commandsJson}
                    spellCheck={false}
                    className="min-h-[220px] font-mono text-xs"
                    onChange={(event) => setCommandsJson(event.target.value)}
                  />
                </div>
              </div>

              {applicationCommands.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {applicationCommands.map((command) => (
                    <span
                      key={idString(command.id)}
                      className="rounded-md border border-border bg-muted/30 px-2 py-1 text-xs"
                    >
                      /{command.name}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border bg-background/50 p-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={permissionsTab === "public" ? "secondary" : "outline"}
                  onClick={() => setPermissionsTab("public")}
                >
                  {t("developerBots.defaultDiscoveryPermissions")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={permissionsTab === "url" ? "secondary" : "outline"}
                  onClick={() => setPermissionsTab("url")}
                >
                  {t("developerBots.botAuthUrlGenerator")}
                </Button>
              </div>

              {permissionsTab === "public" ? (
                <div className="mt-4">
                  <BotPermissionPicker
                    value={form.defaultPermissions}
                    onChange={(defaultPermissions) =>
                      setForm((current) => ({ ...current, defaultPermissions }))
                    }
                    compact
                  />
                </div>
              ) : (
                <div className="mt-4">
                  <BotPermissionPicker
                    value={grantPermissions}
                    onChange={setGrantPermissions}
                    compact
                  />

                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="grant-expiry">
                        {t("developerBots.expiresInSeconds")}
                      </Label>
                      <Input
                        id="grant-expiry"
                        type="number"
                        min={60}
                        value={grantExpiresIn}
                        onChange={(event) =>
                          setGrantExpiresIn(
                            Math.max(
                              60,
                              Number(event.target.value) ||
                                INSTALL_GRANT_DEFAULT_TTL,
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="grant-uses">
                        {t("developerBots.maxUses")}
                      </Label>
                      <div className="flex gap-2">
                        <Input
                          id="grant-uses"
                          type="number"
                          min={1}
                          value={grantMaxUses}
                          disabled={grantUnlimitedUses}
                          onChange={(event) =>
                            setGrantMaxUses(
                              Math.max(
                                1,
                                Number(event.target.value) ||
                                  INSTALL_GRANT_DEFAULT_MAX_USES,
                              ),
                            )
                          }
                        />
                        <Button
                          type="button"
                          variant={grantUnlimitedUses ? "secondary" : "outline"}
                          onClick={() =>
                            setGrantUnlimitedUses((current) => !current)
                          }
                        >
                          {t("developerBots.unlimited")}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t("developerBots.unlimitedUsesDesc")}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      className="gap-2"
                      disabled={grantBusy}
                      onClick={() => void handleCreateGrant()}
                    >
                      <Link2 className="h-4 w-4" />
                      {t("developerBots.generateUrl")}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {t("developerBots.selectedBitmask", {
                        value: grantPermissions,
                      })}
                    </span>
                  </div>

                  {installUrl && (
                    <div className="mt-4 rounded-md border border-border bg-muted/20 p-3">
                      <div className="flex items-center gap-2">
                        <Input
                          value={installUrl}
                          readOnly
                          className="font-mono text-xs"
                        />
                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          onClick={() =>
                            void copyText(
                              installUrl,
                              t("developerBots.installUrlCopied"),
                            )
                          }
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )}

                  <Separator className="my-4" />
                  <div className="space-y-2">
                    <p className="text-sm font-medium">
                      {t("developerBots.activeGrants")}
                    </p>
                    {grantsLoading ? (
                      <p className="text-sm text-muted-foreground">
                        {t("developerBots.loadingGrants")}
                      </p>
                    ) : activeGrants.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t("developerBots.noActiveInstallGrants")}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {activeGrants.map((grant) => {
                          const maxUses =
                            (grant.max_uses ?? 0) === 0
                              ? t("developerBots.unlimited")
                              : String(grant.max_uses ?? 0);
                          return (
                            <div
                              key={idString(grant.id)}
                              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                            >
                              <div className="min-w-0">
                                <p className="text-sm font-medium">
                                  {t("developerBots.grantPrefix", {
                                    prefix:
                                      grant.token_prefix ??
                                      t("developerBots.unknown"),
                                  })}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {t("developerBots.grantMeta", {
                                    permissions:
                                      grant.requested_permissions ?? 0,
                                    uses: grant.uses ?? 0,
                                    maxUses,
                                    expires: formatDate(grant.expires_at, t),
                                  })}
                                </p>
                              </div>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={grantBusy}
                                onClick={() => void handleRevokeGrant(grant)}
                              >
                                {t("developerBots.revoke")}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-destructive">
                    {t("developerBots.deleteBot")}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {t("developerBots.deleteBotDesc")}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="gap-2"
                  disabled={deleting}
                  onClick={() => void handleDeleteBot()}
                >
                  <Trash2 className="h-4 w-4" />
                  {t("developerBots.delete")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ColorInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-14 shrink-0 p-1"
        />
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="font-mono text-xs"
        />
      </div>
    </div>
  );
}

function ToggleRow({
  icon,
  title,
  description,
  value,
  onToggle,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/50 p-3 text-left transition-colors hover:bg-accent/40"
    >
      <span className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 text-muted-foreground">{icon}</span>
        <span className="min-w-0">
          <span className="block text-sm font-medium">{title}</span>
          <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
            {description}
          </span>
        </span>
      </span>
      <span
        className={cn(
          "relative h-5 w-10 shrink-0 rounded-full transition-colors",
          value ? "bg-green-500" : "bg-muted",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform",
            value && "translate-x-5",
          )}
        />
      </span>
    </button>
  );
}
