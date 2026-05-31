import { axiosInstance } from "@/api/client";
import type {
  DtoAvatarUpload,
  DtoBannerUpload,
  DtoGuild,
  DtoMember,
  DtoRole,
  DtoUser,
} from "@/client";
import { getApiBaseUrl } from "@/lib/connectionConfig";

export type Snowflake = string | number;
export type BotUser = DtoUser & {
  flags?: number;
  is_bot?: boolean;
};

export interface DeveloperBot {
  bot_user_id: Snowflake;
  owner_user_id: Snowflake;
  user?: BotUser;
  description?: string;
  tags?: string[];
  public?: boolean;
  default_permissions?: number;
  disabled?: boolean;
  created_at?: number;
  updated_at?: number;
}

export interface CreateDeveloperBotRequest {
  name: string;
  description?: string;
  public?: boolean;
  default_permissions?: number;
  tags?: string[];
}

export interface UpdateDeveloperBotRequest {
  name?: string;
  bio?: string;
  avatar?: Snowflake;
  banner?: Snowflake;
  banner_color?: number;
  panel_color?: number;
  description?: string;
  tags?: string[];
  public?: boolean;
  default_permissions?: number;
  disabled?: boolean;
}

export interface BotRuntimeToken {
  id: Snowflake;
  bot_user_id: Snowflake;
  name?: string;
  token_prefix?: string;
  revoked_at?: string | null;
  last_used_at?: string | null;
  created_at?: string;
}

export interface CreateBotTokenResponse {
  token: string;
  token_data: BotRuntimeToken;
}

export interface BotInstallGrant {
  id: Snowflake;
  bot_user_id: Snowflake;
  owner_user_id: Snowflake;
  token_prefix?: string;
  requested_permissions?: number;
  expires_at?: string;
  max_uses?: number;
  uses?: number;
  revoked_at?: string | null;
  created_at?: string;
}

export interface CreateBotGrantResponse {
  token: string;
  grant: BotInstallGrant;
}

export interface InstalledBot {
  bot_user_id: Snowflake;
  user?: BotUser;
  roles?: Snowflake[];
  granted_permissions?: number;
  installer_user_id?: Snowflake;
  grant_id?: Snowflake;
  created_at?: number;
  member?: DtoMember;
}

export interface BotAuthorizationPreview {
  bot: DeveloperBot;
  requested_permissions: number;
  grant_id?: Snowflake;
}

export interface BotDiscovery {
  bot_user_id: Snowflake;
  user?: BotUser;
  description?: string;
  tags?: string[];
  default_permissions?: number;
  installs_count?: number;
  created_at?: number;
  updated_at?: number;
}

export interface BotDiscoverySearchResponse {
  bots?: BotDiscovery[];
  pages?: number;
}

const apiBase = () => getApiBaseUrl();
const id = (value: Snowflake) => encodeURIComponent(String(value));

function normalizeBasePath(raw: string | undefined): string {
  if (!raw || raw === "/") return "";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function buildBotInstallUrl(
  grantToken: string,
  permissions: number,
): string {
  const params = new URLSearchParams({
    grant_token: grantToken,
    permissions: String(permissions),
  });
  const path = `/bot/authorize?${params.toString()}`;

  if (typeof window === "undefined") return path;
  if (window.location.protocol === "file:") {
    return `${getApiBaseUrl()
      .replace(/\/api\/v1\/?$/, "")
      .replace(/\/$/, "")}${path}`;
  }

  const basePath = normalizeBasePath(
    import.meta.env.VITE_BASE_PATH as string | undefined,
  );
  if (window.location.hash.startsWith("#/"))
    return `${window.location.origin}/#${basePath}${path}`;
  return `${window.location.origin}${basePath}${path}`;
}

export const botsApi = {
  async listDeveloperBots(): Promise<DeveloperBot[]> {
    const response = await axiosInstance.get<DeveloperBot[]>(
      `${apiBase()}/developer/bots`,
    );
    return response.data ?? [];
  },

  async createDeveloperBot(
    request: CreateDeveloperBotRequest,
  ): Promise<DeveloperBot> {
    const response = await axiosInstance.post<DeveloperBot>(
      `${apiBase()}/developer/bots`,
      request,
    );
    return response.data;
  },

  async updateDeveloperBot(
    botId: Snowflake,
    request: UpdateDeveloperBotRequest,
  ): Promise<DeveloperBot> {
    const response = await axiosInstance.patch<DeveloperBot>(
      `${apiBase()}/developer/bots/${id(botId)}`,
      request,
    );
    return response.data;
  },

  async deleteDeveloperBot(botId: Snowflake): Promise<void> {
    await axiosInstance.delete(`${apiBase()}/developer/bots/${id(botId)}`);
  },

  async searchBots(params: {
    q?: string;
    tags?: string;
    sort?: "best_match" | "popularity" | "alphabetical";
    page?: number;
    limit?: number;
  }): Promise<BotDiscoverySearchResponse> {
    const response = await axiosInstance.get<BotDiscoverySearchResponse>(
      `${apiBase()}/search/bots`,
      { params },
    );
    return response.data ?? { bots: [], pages: 0 };
  },

  async searchBotTags(params: {
    q?: string;
    limit?: number;
  }): Promise<string[]> {
    const response = await axiosInstance.get<string[]>(
      `${apiBase()}/search/bot-tags`,
      { params },
    );
    return response.data ?? [];
  },

  async createBotAvatarUpload(
    botId: Snowflake,
    request: { content_type: string; file_size: number },
  ): Promise<DtoAvatarUpload> {
    const response = await axiosInstance.post<DtoAvatarUpload>(
      `${apiBase()}/developer/bots/${id(botId)}/avatar`,
      request,
    );
    return response.data;
  },

  async createBotBannerUpload(
    botId: Snowflake,
    request: { content_type: string; file_size: number },
  ): Promise<DtoBannerUpload> {
    const response = await axiosInstance.post<DtoBannerUpload>(
      `${apiBase()}/developer/bots/${id(botId)}/banner`,
      request,
    );
    return response.data;
  },

  async listBotTokens(botId: Snowflake): Promise<BotRuntimeToken[]> {
    const response = await axiosInstance.get<BotRuntimeToken[]>(
      `${apiBase()}/developer/bots/${id(botId)}/tokens`,
    );
    return response.data ?? [];
  },

  async createBotToken(botId: Snowflake): Promise<CreateBotTokenResponse> {
    const response = await axiosInstance.post<CreateBotTokenResponse>(
      `${apiBase()}/developer/bots/${id(botId)}/tokens`,
      {
        name: "default",
      },
    );
    return response.data;
  },

  async revokeBotToken(botId: Snowflake, tokenId: Snowflake): Promise<void> {
    await axiosInstance.delete(
      `${apiBase()}/developer/bots/${id(botId)}/tokens/${id(tokenId)}`,
    );
  },

  async listBotGrants(botId: Snowflake): Promise<BotInstallGrant[]> {
    const response = await axiosInstance.get<BotInstallGrant[]>(
      `${apiBase()}/developer/bots/${id(botId)}/grants`,
    );
    return response.data ?? [];
  },

  async createBotGrant(
    botId: Snowflake,
    request: {
      requested_permissions: number;
      expires_in_seconds: number;
      max_uses: number;
    },
  ): Promise<CreateBotGrantResponse> {
    const response = await axiosInstance.post<CreateBotGrantResponse>(
      `${apiBase()}/developer/bots/${id(botId)}/grants`,
      request,
    );
    return response.data;
  },

  async revokeBotGrant(botId: Snowflake, grantId: Snowflake): Promise<void> {
    await axiosInstance.delete(
      `${apiBase()}/developer/bots/${id(botId)}/grants/${id(grantId)}`,
    );
  },

  async previewBotAuthorization(params: {
    grant_token?: string;
    bot_user_id?: Snowflake;
    permissions?: number;
  }): Promise<BotAuthorizationPreview> {
    const response = await axiosInstance.get<BotAuthorizationPreview>(
      `${apiBase()}/developer/bots/authorize/preview`,
      {
        params,
      },
    );
    return response.data;
  },

  async listBotAuthorizationGuilds(): Promise<DtoGuild[]> {
    const response = await axiosInstance.get<DtoGuild[]>(
      `${apiBase()}/guild/bots/authorize-guilds`,
    );
    return response.data ?? [];
  },

  async listGuildBots(guildId: Snowflake): Promise<InstalledBot[]> {
    const response = await axiosInstance.get<InstalledBot[]>(
      `${apiBase()}/guild/${id(guildId)}/bots`,
    );
    return response.data ?? [];
  },

  async listGuildRoles(guildId: Snowflake): Promise<DtoRole[]> {
    const response = await axiosInstance.get<DtoRole[]>(
      `${apiBase()}/guild/${id(guildId)}/roles`,
    );
    return response.data ?? [];
  },

  async installGuildBot(
    guildId: Snowflake,
    request: {
      grant_token?: string;
      bot_user_id?: Snowflake;
      granted_permissions?: number;
    },
  ): Promise<InstalledBot> {
    const response = await axiosInstance.post<InstalledBot>(
      `${apiBase()}/guild/${id(guildId)}/bots`,
      request,
    );
    return response.data;
  },

  async removeGuildBot(guildId: Snowflake, botId: Snowflake): Promise<void> {
    await axiosInstance.delete(
      `${apiBase()}/guild/${id(guildId)}/bots/${id(botId)}`,
    );
  },
};
