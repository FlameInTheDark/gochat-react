import { create } from 'zustand'
import { axiosInstance } from '@/api/client'
import type { ModelUserSettingsData, ModelUserSettingsGuildFolders, ModelUserSettingsGuilds } from '@/client'
import { queryClient } from '@/lib/queryClient'
import { getApiBaseUrl } from '@/lib/connectionConfig'

export interface GuildFolder {
  /** Locally-generated ID — not persisted to API */
  id: string
  name: string
  /** Color as 0xRRGGBB integer; 0 = no color */
  color: number
  /** Snowflake IDs as strings */
  guildIds: string[]
  collapsed: boolean
}

interface FolderState {
  folders: GuildFolder[]
  /**
   * Flat, ordered list of top-level sidebar items.
   * Each entry is either `'guild:{snowflakeId}'` or `'folder:{localId}'`.
   */
  itemOrder: string[]
  /**
   * Increments every time loadFromSettings runs so that useEffects that
   * depend on the folder layout re-fire even when the guild list hasn't changed.
   * Fixes the race condition where guilds load before settings and syncGuilds
   * never re-runs after loadFromSettings wipes itemOrder.
   */
  settingsVersion: number
  /** Last selected channel per guild, keyed by guildId string. */
  selectedChannels: Record<string, string>

  loadFromSettings: (
    apifolders?: Array<ModelUserSettingsGuildFolders>,
    settingsGuilds?: Array<ModelUserSettingsGuilds>,
  ) => void

  /** Reconcile itemOrder with the live guild list (after query load/refetch). */
  syncGuilds: (allGuildIds: string[]) => void

  /** Persist a new drag-and-drop ordering. */
  reorderItems: (newOrder: string[]) => void

  createFolder: (name: string, color: number, guildIds: string[]) => void
  deleteFolder: (id: string) => void
  updateFolder: (id: string, name: string, color: number) => void
  addGuildToFolder: (folderId: string, guildId: string, atIndex?: number) => void
  removeGuildFromFolder: (guildId: string) => void
  reorderFolderGuilds: (folderId: string, newGuildIds: string[]) => void
  toggleCollapse: (id: string) => void
  getFolderForGuild: (guildId: string) => GuildFolder | undefined
  setSelectedChannel: (guildId: string, channelId: string) => void
  saveToSettings: () => Promise<void>
  /**
   * If a debounced UI-state save is pending, cancel it and merge the accumulated
   * folder/channel data into `existing`, returning the combined settings object.
   * If no save is pending, returns `existing` unchanged.
   * Called automatically by saveSettings() so any immediate config save absorbs
   * accumulated channel-navigation state in one request.
   */
  flushPendingInto: (existing: ModelUserSettingsData) => ModelUserSettingsData
}

let _localIdCounter = 1
function genLocalId(): string {
  return `lf_${_localIdCounter++}_${Date.now()}`
}

// ── Debounced save ───────────────────────────────────────────────────────────
// UI-state changes (channel navigation, folder reorder) are cheap to accumulate
// locally and expensive to save on every action. We batch them with a long timer
// so rapid navigation doesn't hammer the API. Any immediate settings save (voice,
// appearance, etc.) calls flushPendingInto() which cancels this timer and merges
// the accumulated state into that request — zero extra requests.
let _saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave(get: () => FolderState) {
  if (_saveTimer !== null) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => {
    _saveTimer = null
    void get().saveToSettings()
  }, 25_000)
}

// Pure helper — builds the guilds + guild_folders payload from current store state.
function buildFolderPayload(
  existing: ModelUserSettingsData,
  folders: GuildFolder[],
  itemOrder: string[],
  selectedChannels: Record<string, string>,
): ModelUserSettingsData {
  const existingGuildsMap = new Map(
    (existing.guilds ?? []).map((g) => [String(g.guild_id), g]),
  )
  const topLevelSettings = itemOrder
    .filter((x) => x.startsWith('guild:'))
    .map((item, pos) => {
      const guildId = item.slice(6)
      const prev = existingGuildsMap.get(guildId)
      const selCh = selectedChannels[guildId]
      return {
        ...prev,
        guild_id: BigInt(guildId) as unknown as number,
        position: pos,
        ...(selCh ? { selected_channel: BigInt(selCh) as unknown as number } : {}),
      }
    })
  const folderGuildSettings = folders.flatMap((folder) =>
    folder.guildIds.map((guildId, pos) => {
      const prev = existingGuildsMap.get(guildId)
      const selCh = selectedChannels[guildId]
      return {
        ...prev,
        guild_id: BigInt(guildId) as unknown as number,
        position: pos,
        ...(selCh ? { selected_channel: BigInt(selCh) as unknown as number } : {}),
      }
    }),
  )
  return {
    ...existing,
    guilds: [...topLevelSettings, ...folderGuildSettings],
    guild_folders: toApiGuildFolders(folders, itemOrder),
  }
}

// ── Empty-folder cleanup helper ───────────────────────────────────────────────
// Removes folders that have no guilds left and strips their entries from
// itemOrder.  When the folder that just became empty is in itemOrder, the
// replacement `guildItem` (if provided) is spliced in at that position so the
// extracted guild appears where the folder used to be.
function removeEmptyFolders(
  folders: GuildFolder[],
  itemOrder: string[],
  replacements: Map<string, string> = new Map(),
): { folders: GuildFolder[]; itemOrder: string[] } {
  const emptyIds = new Set(folders.filter((f) => f.guildIds.length === 0).map((f) => f.id))
  if (emptyIds.size === 0) return { folders, itemOrder }

  const cleanFolders = folders.filter((f) => !emptyIds.has(f.id))
  const cleanOrder: string[] = []
  for (const item of itemOrder) {
    if (item.startsWith('folder:')) {
      const fId = item.slice(7)
      if (emptyIds.has(fId)) {
        // Replace the empty folder slot with the extracted guild (if any)
        const replacement = replacements.get(fId)
        if (replacement) cleanOrder.push(replacement)
        continue
      }
    }
    cleanOrder.push(item)
  }

  return { folders: cleanFolders, itemOrder: cleanOrder }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function toApiGuildFolders(
  folders: GuildFolder[],
  itemOrder: string[],
): Array<ModelUserSettingsGuildFolders> {
  // Derive folder order from itemOrder
  const folderIds = itemOrder.filter((x) => x.startsWith('folder:')).map((x) => x.slice(7))
  const orderedFolders = [
    ...folderIds.map((fid) => folders.find((f) => f.id === fid)).filter((f): f is GuildFolder => !!f),
    ...folders.filter((f) => !folderIds.includes(f.id)), // safety: include unlisted folders at end
  ]
  return orderedFolders.map((f, i) => ({
    name: f.name,
    color: f.color || undefined,
    guilds: f.guildIds.map((g) => BigInt(g) as unknown as number),
    position: i,
  }))
}

// ── store ────────────────────────────────────────────────────────────────────

export const useFolderStore = create<FolderState>((set, get) => ({
  folders: [],
  itemOrder: [],
  settingsVersion: 0,
  selectedChannels: {},

  // ── load / sync ──────────────────────────────────────────────────────────

  loadFromSettings: (apifolders, settingsGuilds) => {
    const folders: GuildFolder[] = (apifolders ?? []).map((f, i) => ({
      id: genLocalId(),
      name: f.name ?? `Folder ${i + 1}`,
      color: f.color ?? 0,
      guildIds: (f.guilds ?? []).map((g) => String(g)),
      collapsed: false,
    }))

    const folderGuildIds = new Set(folders.flatMap((f) => f.guildIds))

    // Build a position-sorted list of all top-level items
    type Entry = { pos: number; item: string }
    const entries: Entry[] = []

    // Ungrouped guilds from settings.guilds[]
    for (const sg of settingsGuilds ?? []) {
      const gid = String(sg.guild_id)
      if (!folderGuildIds.has(gid)) {
        entries.push({ pos: sg.position ?? 9999, item: `guild:${gid}` })
      }
    }

    // Folders, ordered by their saved position
    for (let i = 0; i < folders.length; i++) {
      const pos = apifolders?.[i]?.position ?? 9999 + i
      entries.push({ pos, item: `folder:${folders[i].id}` })
    }

    const selectedChannels: Record<string, string> = {}
    for (const sg of settingsGuilds ?? []) {
      if (sg.selected_channel) {
        selectedChannels[String(sg.guild_id)] = String(sg.selected_channel)
      }
    }

    entries.sort((a, b) => a.pos - b.pos)
    set((s) => ({ folders, itemOrder: entries.map((e) => e.item), selectedChannels, settingsVersion: s.settingsVersion + 1 }))
  },

  syncGuilds: (allGuildIds) => {
    const { itemOrder, folders } = get()
    const folderGuildIds = new Set(folders.flatMap((f) => f.guildIds))
    const allSet = new Set(allGuildIds)

    // Guild IDs already tracked in itemOrder
    const orderedGuildIds = new Set(
      itemOrder.filter((x) => x.startsWith('guild:')).map((x) => x.slice(6)),
    )

    // Remove guilds that are no longer in the guild list
    const filtered = itemOrder.filter((item) => {
      if (item.startsWith('guild:')) return allSet.has(item.slice(6))
      return true // keep folders
    })

    // Append newly-joined guilds that aren't tracked yet and aren't in a folder
    const toAdd = allGuildIds
      .filter((id) => !orderedGuildIds.has(id) && !folderGuildIds.has(id))
      .map((id) => `guild:${id}`)

    const newOrder = [...filtered, ...toAdd]
    if (newOrder.join(',') !== itemOrder.join(',')) {
      set({ itemOrder: newOrder })
    }
  },

  reorderItems: (newOrder) => {
    set({ itemOrder: newOrder })
    scheduleSave(get)
  },

  // ── folder mutations ─────────────────────────────────────────────────────

  createFolder: (name, color, guildIds) => {
    const newFolder: GuildFolder = {
      id: genLocalId(),
      name,
      color,
      guildIds,
      collapsed: false,
    }
    set((s) => {
      // Remove the guilds from any other folder they're in
      const updatedFolders = [
        ...s.folders.map((f) => ({
          ...f,
          guildIds: f.guildIds.filter((g) => !guildIds.includes(g)),
        })),
        newFolder,
      ]

      // Remove guild entries for the merged guilds; append the new folder entry
      // (place the folder where the first guild used to be)
      const firstGuildItem = guildIds.map((g) => `guild:${g}`).find((item) => s.itemOrder.includes(item))
      const firstGuildIdx = firstGuildItem ? s.itemOrder.indexOf(firstGuildItem) : s.itemOrder.length

      const withoutMergedGuilds = s.itemOrder.filter(
        (item) => !guildIds.map((g) => `guild:${g}`).includes(item),
      )

      const insertAt = Math.min(firstGuildIdx, withoutMergedGuilds.length)
      const withNewFolder = [
        ...withoutMergedGuilds.slice(0, insertAt),
        `folder:${newFolder.id}`,
        ...withoutMergedGuilds.slice(insertAt),
      ]

      // Clean up any source folders that became empty
      const { folders: cleanFolders, itemOrder: cleanOrder } = removeEmptyFolders(
        updatedFolders,
        withNewFolder,
      )

      return { folders: cleanFolders, itemOrder: cleanOrder }
    })
    scheduleSave(get)
  },

  deleteFolder: (id) => {
    set((s) => {
      const folder = s.folders.find((f) => f.id === id)
      const restoredGuilds = (folder?.guildIds ?? []).map((g) => `guild:${g}`)

      // Replace the folder entry in itemOrder with the guilds it contained
      const folderItem = `folder:${id}`
      const folderIdx = s.itemOrder.indexOf(folderItem)
      let newOrder: string[]
      if (folderIdx !== -1) {
        newOrder = [
          ...s.itemOrder.slice(0, folderIdx),
          ...restoredGuilds,
          ...s.itemOrder.slice(folderIdx + 1),
        ]
      } else {
        newOrder = [...s.itemOrder, ...restoredGuilds]
      }

      return {
        folders: s.folders.filter((f) => f.id !== id),
        itemOrder: newOrder,
      }
    })
    scheduleSave(get)
  },

  updateFolder: (id, name, color) => {
    set((s) => ({
      folders: s.folders.map((f) => (f.id === id ? { ...f, name, color } : f)),
    }))
    scheduleSave(get)
  },

  addGuildToFolder: (folderId, guildId, atIndex) => {
    set((s) => {
      const updatedFolders = s.folders.map((f) => {
        if (f.id === folderId) {
          if (f.guildIds.includes(guildId)) return f
          const ids = atIndex !== undefined
            ? [...f.guildIds.slice(0, atIndex), guildId, ...f.guildIds.slice(atIndex)]
            : [...f.guildIds, guildId]
          return { ...f, guildIds: ids }
        }
        // Remove from any other folder it may be in
        return { ...f, guildIds: f.guildIds.filter((g) => g !== guildId) }
      })

      // Remove the guild from top-level order (it now lives inside a folder)
      const withoutGuild = s.itemOrder.filter((item) => item !== `guild:${guildId}`)

      // Auto-delete any folder that became empty after we removed the guild
      const { folders: cleanFolders, itemOrder: cleanOrder } = removeEmptyFolders(
        updatedFolders,
        withoutGuild,
      )

      return { folders: cleanFolders, itemOrder: cleanOrder }
    })
    scheduleSave(get)
  },

  removeGuildFromFolder: (guildId) => {
    set((s) => {
      // Find the folder that owns this guild so we can place the extracted
      // guild at the folder's position if the folder becomes empty.
      const owningFolderId = s.folders.find((f) => f.guildIds.includes(guildId))?.id

      const updatedFolders = s.folders.map((f) => ({
        ...f,
        guildIds: f.guildIds.filter((g) => g !== guildId),
      }))

      const guildItem = `guild:${guildId}`

      // Ensure the guild appears in top-level order (it may already be there
      // if this is called redundantly, so guard with includes).
      let withGuild: string[]
      if (s.itemOrder.includes(guildItem)) {
        withGuild = s.itemOrder
      } else {
        // If the owning folder is about to become empty, its slot in itemOrder
        // will be replaced by the guild via removeEmptyFolders' replacement map.
        // Otherwise append the guild after the folder (which stays).
        withGuild = [...s.itemOrder, guildItem]
      }

      // Build a replacement map: if a folder becomes empty, put the guild there.
      const replacements = new Map<string, string>()
      if (owningFolderId) {
        const afterRemoval = updatedFolders.find((f) => f.id === owningFolderId)
        if (afterRemoval && afterRemoval.guildIds.length === 0) {
          // Folder is now empty → replace its slot with the extracted guild.
          // Remove the redundant append we added above first.
          const idx = withGuild.lastIndexOf(guildItem)
          if (idx !== -1 && idx === withGuild.length - 1) {
            withGuild = withGuild.slice(0, -1)
          }
          replacements.set(owningFolderId, guildItem)
        }
      }

      const { folders: cleanFolders, itemOrder: cleanOrder } = removeEmptyFolders(
        updatedFolders,
        withGuild,
        replacements,
      )

      return { folders: cleanFolders, itemOrder: cleanOrder }
    })
    scheduleSave(get)
  },

  reorderFolderGuilds: (folderId, newGuildIds) => {
    set((s) => ({
      folders: s.folders.map((f) =>
        f.id === folderId ? { ...f, guildIds: newGuildIds } : f,
      ),
    }))
    scheduleSave(get)
  },

  toggleCollapse: (id) => {
    set((s) => ({
      folders: s.folders.map((f) => (f.id === id ? { ...f, collapsed: !f.collapsed } : f)),
    }))
    // Collapsed state is session-only — not persisted
  },

  getFolderForGuild: (guildId) => {
    return get().folders.find((f) => f.guildIds.includes(guildId))
  },

  setSelectedChannel: (guildId, channelId) => {
    set((s) => ({
      selectedChannels: { ...s.selectedChannels, [guildId]: channelId },
    }))
    scheduleSave(get)
  },

  // ── persistence ───────────────────────────────────────────────────────────

  saveToSettings: async () => {
    try {
      const { folders, itemOrder, selectedChannels } = get()
      const existing = queryClient.getQueryData<ModelUserSettingsData>(['user-settings']) ?? {}
      // Use axiosInstance directly — generated client's serializeDataIfNeeded()
      // calls JSON.stringify() which cannot handle BigInt Snowflake IDs.
      const updated = buildFolderPayload(existing, folders, itemOrder, selectedChannels)
      const baseUrl = getApiBaseUrl()
      await axiosInstance.post(`${baseUrl}/user/me/settings`, updated)
      queryClient.setQueryData(['user-settings'], updated)
    } catch {
      // Non-critical — silently ignore save failures
    }
  },

  flushPendingInto: (existing) => {
    if (_saveTimer === null) return existing
    clearTimeout(_saveTimer)
    _saveTimer = null
    const { folders, itemOrder, selectedChannels } = get()
    return buildFolderPayload(existing, folders, itemOrder, selectedChannels)
  },
}))
