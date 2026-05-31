import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { cn } from "@/lib/utils";

const DEFAULT_BANNER_COLOR = "#5865f2";
const DEFAULT_PANEL_COLOR = "#2b2d31";
const INSTALL_GRANT_DEFAULT_TTL = 60 * 60 * 24 * 7;
const INSTALL_GRANT_DEFAULT_MAX_USES = 1;
const BOT_AVATAR_MAX_SIZE = 250 * 1024;
const BOT_BANNER_MAX_SIZE = 10 * 1024 * 1024;

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
  if ((grant.max_uses ?? 0) <= (grant.uses ?? 0)) return false;
  if (!grant.expires_at) return true;
  return new Date(grant.expires_at).getTime() > Date.now();
}

function formatDate(value?: string | number | null): string {
  if (value == null || value === "") return "Never";
  const date =
    typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

function idString(value: Snowflake | undefined): string {
  return value == null ? "" : String(value);
}

async function copyText(value: string, message: string) {
  await navigator.clipboard.writeText(value);
  toast.success(message);
}

export default function DeveloperBotsSection() {
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
  const [oneTimeToken, setOneTimeToken] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    bio: "",
    description: "",
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
    setOneTimeToken(null);
    setInstallUrl(null);
  }, [selectedBot]);

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
      toast.success("Bot created");
    } catch {
      toast.error("Failed to create bot");
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveBot() {
    if (!selectedBot) return;
    const name = form.name.trim();
    if (!name) {
      toast.error("Bot name is required");
      return;
    }

    setSaving(true);
    try {
      await botsApi.updateDeveloperBot(selectedBot.bot_user_id, {
        name,
        bio: form.bio.trim(),
        description: form.description.trim(),
        public: form.public,
        disabled: form.disabled,
        default_permissions: form.defaultPermissions,
        banner_color: hexToNum(form.bannerColor),
        panel_color: hexToNum(form.panelColor),
      });
      await queryClient.invalidateQueries({ queryKey: ["developer-bots"] });
      toast.success("Bot saved");
    } catch {
      toast.error("Failed to save bot");
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
      toast.error("Avatar must be an image");
      return;
    }
    if (file.size > BOT_AVATAR_MAX_SIZE) {
      toast.error("Avatar file is too large");
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
        userId: String(placeholder.user_id),
        avatarId: String(placeholder.id),
        file: file as unknown as number[],
      });
      await botsApi.updateDeveloperBot(selectedBot.bot_user_id, {
        avatar: placeholder.id,
      });
      await queryClient.invalidateQueries({ queryKey: ["developer-bots"] });
      toast.success("Bot avatar updated");
    } catch {
      toast.error("Failed to upload bot avatar");
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
      toast.error("Banner must be an image");
      return;
    }
    if (file.size > BOT_BANNER_MAX_SIZE) {
      toast.error("Banner file is too large");
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
      toast.success("Bot banner updated");
    } catch {
      toast.error("Failed to upload bot banner");
    } finally {
      setUploadingBanner(false);
    }
  }

  async function handleDeleteBot() {
    if (!selectedBot || deleting) return;
    const confirmed = window.confirm(
      `Delete ${selectedBot.user?.name ?? "this bot"}?`,
    );
    if (!confirmed) return;

    setDeleting(true);
    try {
      await botsApi.deleteDeveloperBot(selectedBot.bot_user_id);
      await queryClient.invalidateQueries({ queryKey: ["developer-bots"] });
      toast.success("Bot deleted");
    } catch {
      toast.error("Failed to delete bot");
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
          ? "Bot token regenerated"
          : "Bot token generated",
      );
    } catch {
      toast.error("Failed to generate bot token");
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
      toast.success("Bot token revoked");
    } catch {
      toast.error("Failed to revoke bot token");
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
        max_uses: grantMaxUses,
      });
      const url = buildBotInstallUrl(created.token, grantPermissions);
      setInstallUrl(url);
      await queryClient.invalidateQueries({
        queryKey: ["developer-bot-grants", selectedBotKey],
      });
      toast.success("Install URL generated");
    } catch {
      toast.error("Failed to generate install URL");
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
      toast.success("Install grant revoked");
    } catch {
      toast.error("Failed to revoke install grant");
    } finally {
      setGrantBusy(false);
    }
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
                {form.name || selectedBot.user?.name || "Bot settings"}
              </h2>
              <p className="text-sm text-muted-foreground">
                ID {idString(selectedBot.bot_user_id)}
              </p>
            </div>
          </div>
        ) : (
          <div>
            <h2 className="text-xl font-bold">Developer</h2>
            <p className="text-sm text-muted-foreground">
              Create and configure bot accounts.
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
                New bot
              </Label>
              <div className="mt-2 flex gap-2">
                <Input
                  id="new-bot-name"
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleCreateBot();
                  }}
                  placeholder="Bot name"
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
                  Loading bots...
                </div>
              ) : bots.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">
                  No bots created yet.
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
                            {bot.user?.name ?? "Unnamed bot"}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                            <Bot className="h-3 w-3" />
                            {bot.public ? "Public" : "Private"}
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
                  Banner
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
                      {form.name || "Unnamed bot"}
                    </h3>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Bot
                    </span>
                    {form.disabled && (
                      <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-destructive">
                        Disabled
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    ID {idString(selectedBot.bot_user_id)}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="gap-2"
                      disabled={saving}
                      onClick={() => void handleSaveBot()}
                    >
                      <Save className="h-4 w-4" />
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-2"
                      onClick={() =>
                        void copyText(
                          idString(selectedBot.bot_user_id),
                          "Bot ID copied",
                        )
                      }
                    >
                      <Copy className="h-4 w-4" />
                      Copy ID
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-background/50 p-4">
              <h3 className="text-base font-semibold">Profile</h3>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="bot-name">Bot name</Label>
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
                  <Label htmlFor="bot-description">Bot description</Label>
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
                <Label htmlFor="bot-bio">Profile bio</Label>
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
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <ColorInput
                  id="bot-banner-color"
                  label="Banner color"
                  value={form.bannerColor}
                  onChange={(value) =>
                    setForm((current) => ({ ...current, bannerColor: value }))
                  }
                />
                <ColorInput
                  id="bot-panel-color"
                  label="Panel color"
                  value={form.panelColor}
                  onChange={(value) =>
                    setForm((current) => ({ ...current, panelColor: value }))
                  }
                />
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <ToggleRow
                  icon={<Globe className="h-4 w-4" />}
                  title="Public discovery"
                  description="Allow server admins to find this bot in discovery."
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
                  title="Runtime disabled"
                  description="Block token auth and bot gateway sessions."
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
              <h3 className="text-base font-semibold">
                Default discovery permissions
              </h3>
              <div className="mt-4">
                <BotPermissionPicker
                  value={form.defaultPermissions}
                  onChange={(defaultPermissions) =>
                    setForm((current) => ({ ...current, defaultPermissions }))
                  }
                  compact
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-background/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">Runtime token</h3>
                  <p className="text-xs text-muted-foreground">
                    {tokensLoading
                      ? "Checking token..."
                      : latestActiveToken
                        ? `Active token prefix: ${latestActiveToken.token_prefix ?? "unknown"}`
                        : "No active token"}
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
                      Revoke
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
                    {latestActiveToken ? "Regenerate" : "Generate"}
                  </Button>
                </div>
              </div>
              {oneTimeToken && (
                <div className="mt-4 rounded-md border border-primary/30 bg-primary/5 p-3">
                  <div className="flex items-start gap-3">
                    <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">Token shown once</p>
                      <code className="mt-2 block overflow-x-auto rounded bg-background px-2 py-1.5 text-xs">
                        {oneTimeToken}
                      </code>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() =>
                        void copyText(oneTimeToken, "Token copied")
                      }
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border bg-background/50 p-4">
              <h3 className="text-base font-semibold">
                Bot auth URL generator
              </h3>
              <div className="mt-4">
                <BotPermissionPicker
                  value={grantPermissions}
                  onChange={setGrantPermissions}
                  compact
                />
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="grant-expiry">Expires in seconds</Label>
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
                  <Label htmlFor="grant-uses">Max uses</Label>
                  <Input
                    id="grant-uses"
                    type="number"
                    min={1}
                    value={grantMaxUses}
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
                  Generate URL
                </Button>
                <span className="text-xs text-muted-foreground">
                  Selected bitmask: {grantPermissions}
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
                        void copyText(installUrl, "Install URL copied")
                      }
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
              <Separator className="my-4" />
              <div className="space-y-2">
                <p className="text-sm font-medium">Active grants</p>
                {grantsLoading ? (
                  <p className="text-sm text-muted-foreground">
                    Loading grants...
                  </p>
                ) : activeGrants.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No active install grants.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {activeGrants.map((grant) => (
                      <div
                        key={idString(grant.id)}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium">
                            Prefix {grant.token_prefix ?? "unknown"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Bitmask {grant.requested_permissions ?? 0} - Uses{" "}
                            {grant.uses ?? 0}/{grant.max_uses ?? 0} - Expires{" "}
                            {formatDate(grant.expires_at)}
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={grantBusy}
                          onClick={() => void handleRevokeGrant(grant)}
                        >
                          Revoke
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-destructive">
                    Delete bot
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Remove the bot account, tokens, grants, and server installs.
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
                  Delete
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
