import { create } from 'zustand'
import type { ContextMenuItem } from '@/types'

interface DeleteTarget {
  type: 'channel' | 'message'
  id: string
}

interface ContextMenuState {
  x: number
  y: number
  items: ContextMenuItem[]
}

interface UserProfileState {
  userId: string
  guildId: string | null
  x: number
  y: number
  /** Optional fallback name if member not in query cache (e.g., clicked from chat) */
  fallbackName?: string
}

interface UiState {
  createServerOpen: boolean
  createChannelOpen: boolean
  createChannelParentId: string | null
  createChannelServerId: string | null
  createCategoryOpen: boolean
  createCategoryServerId: string | null
  inviteModalOpen: boolean
  inviteModalServerId: string | null
  joinServerOpen: boolean
  appSettingsOpen: boolean
  serverSettingsGuildId: string | null
  channelSettingsChannelId: string | null
  channelSettingsGuildId: string | null
  userProfile: UserProfileState | null
  deleteTarget: DeleteTarget | null
  contextMenu: ContextMenuState | null
  openCreateServer: () => void
  closeCreateServer: () => void
  openCreateChannel: (parentId?: string, serverId?: string) => void
  closeCreateChannel: () => void
  openCreateCategory: (serverId?: string) => void
  closeCreateCategory: () => void
  openInviteModal: (serverId: string) => void
  closeInviteModal: () => void
  openJoinServer: () => void
  closeJoinServer: () => void
  openAppSettings: () => void
  closeAppSettings: () => void
  openServerSettings: (guildId: string) => void
  closeServerSettings: () => void
  openChannelSettings: (guildId: string, channelId: string) => void
  closeChannelSettings: () => void
  openUserProfile: (userId: string, guildId: string | null, x: number, y: number, fallbackName?: string) => void
  closeUserProfile: () => void
  setDeleteTarget: (target: DeleteTarget | null) => void
  openContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void
  closeContextMenu: () => void
}

export const useUiStore = create<UiState>((set) => ({
  createServerOpen: false,
  createChannelOpen: false,
  createChannelParentId: null,
  createChannelServerId: null,
  createCategoryOpen: false,
  createCategoryServerId: null,
  inviteModalOpen: false,
  inviteModalServerId: null,
  joinServerOpen: false,
  appSettingsOpen: false,
  serverSettingsGuildId: null,
  channelSettingsChannelId: null,
  channelSettingsGuildId: null,
  userProfile: null,
  deleteTarget: null,
  contextMenu: null,

  openCreateServer: () => set({ createServerOpen: true }),
  closeCreateServer: () => set({ createServerOpen: false }),

  openCreateChannel: (parentId, serverId) => set({
    createChannelOpen: true,
    createChannelParentId: parentId ?? null,
    createChannelServerId: serverId ?? null,
  }),
  closeCreateChannel: () => set({ createChannelOpen: false, createChannelParentId: null, createChannelServerId: null }),

  openCreateCategory: (serverId) => set({ createCategoryOpen: true, createCategoryServerId: serverId ?? null }),
  closeCreateCategory: () => set({ createCategoryOpen: false, createCategoryServerId: null }),

  openInviteModal: (serverId) => set({ inviteModalOpen: true, inviteModalServerId: serverId }),
  closeInviteModal: () => set({ inviteModalOpen: false, inviteModalServerId: null }),

  openJoinServer: () => set({ joinServerOpen: true }),
  closeJoinServer: () => set({ joinServerOpen: false }),

  openAppSettings: () => set({ appSettingsOpen: true }),
  closeAppSettings: () => set({ appSettingsOpen: false }),

  openServerSettings: (guildId) => set({ serverSettingsGuildId: guildId }),
  closeServerSettings: () => set({ serverSettingsGuildId: null }),

  openChannelSettings: (guildId, channelId) => set({ channelSettingsGuildId: guildId, channelSettingsChannelId: channelId }),
  closeChannelSettings: () => set({ channelSettingsGuildId: null, channelSettingsChannelId: null }),

  openUserProfile: (userId, guildId, x, y, fallbackName) => set({ userProfile: { userId, guildId, x, y, fallbackName } }),
  closeUserProfile: () => set({ userProfile: null }),

  setDeleteTarget: (target) => set({ deleteTarget: target }),

  openContextMenu: (x, y, items) => set({ contextMenu: { x, y, items } }),
  closeContextMenu: () => set({ contextMenu: null }),
}))
