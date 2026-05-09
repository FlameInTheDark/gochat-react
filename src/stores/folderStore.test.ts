import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFolderStore } from '@/stores/folderStore'
import type { ModelUserSettingsData } from '@/client'

vi.mock('@/api/client', () => ({
  axiosInstance: {
    get: vi.fn(),
    post: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  },
}))

vi.mock('@/lib/queryClient', () => ({
  queryClient: {
    getQueryData: vi.fn(),
    setQueryData: vi.fn(),
  },
}))

function resetFolderStore() {
  useFolderStore.setState({
    folders: [],
    itemOrder: [],
    settingsVersion: 0,
    settingsLoaded: false,
    selectedChannels: {},
  })
}

describe('folderStore server ordering', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetFolderStore()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads server and folder order from shared top-level positions', () => {
    useFolderStore.getState().loadFromSettings(
      [{ name: 'Work', guilds: [2 as never], position: 0 }],
      [
        { guild_id: 1 as never, position: 1 },
        { guild_id: 3 as never, position: 2 },
      ],
    )

    const { itemOrder } = useFolderStore.getState()

    expect(itemOrder[0]).toMatch(/^folder:/)
    expect(itemOrder.slice(1)).toEqual(['guild:1', 'guild:3'])
  })

  it('persists reordered servers and folders in one global coordinate system', () => {
    useFolderStore.getState().loadFromSettings(
      [{ name: 'Work', guilds: [2 as never], position: 0, collapsed: true }],
      [
        { guild_id: 1 as never, position: 1 },
        { guild_id: 3 as never, position: 2 },
      ],
    )
    const folderItem = useFolderStore.getState().itemOrder.find((item) => item.startsWith('folder:'))!

    useFolderStore.getState().reorderItems(['guild:1', folderItem, 'guild:3'])

    const payload = useFolderStore.getState().flushPendingInto({} as ModelUserSettingsData)

    expect(payload.guilds?.map((g) => [String(g.guild_id), g.position])).toEqual([
      ['1', 0],
      ['3', 2],
      ['2', 0],
    ])
    expect(payload.guild_folders?.map((folder) => [folder.name, folder.position])).toEqual([
      ['Work', 1],
    ])
    expect(payload.guild_folders?.[0].collapsed).toBe(true)
  })

  it('loads and saves folder collapsed state', () => {
    useFolderStore.getState().loadFromSettings(
      [{ name: 'Work', guilds: [2 as never], position: 0, collapsed: true }],
      [],
    )

    const folder = useFolderStore.getState().folders[0]

    expect(folder.collapsed).toBe(true)

    useFolderStore.getState().toggleCollapse(folder.id)
    const payload = useFolderStore.getState().flushPendingInto({} as ModelUserSettingsData)

    expect(payload.guild_folders?.[0].collapsed).toBe(false)
  })

  it('does not persist fallback API order when settings have not loaded', () => {
    const existing = {
      guilds: [{ guild_id: 9 as never, position: 0 }],
    } as ModelUserSettingsData

    useFolderStore.getState().syncGuilds(['3', '1'])
    useFolderStore.getState().setSelectedChannel('3', '300')

    const payload = useFolderStore.getState().flushPendingInto(existing)

    expect(useFolderStore.getState().itemOrder).toEqual(['guild:3', 'guild:1'])
    expect(payload).toBe(existing)
  })

  it('allows an explicit user reorder to persist even before settings load finishes', () => {
    useFolderStore.getState().syncGuilds(['3', '1'])
    useFolderStore.getState().reorderItems(['guild:1', 'guild:3'])

    const payload = useFolderStore.getState().flushPendingInto({} as ModelUserSettingsData)

    expect(payload.guilds?.map((g) => [String(g.guild_id), g.position])).toEqual([
      ['1', 0],
      ['3', 1],
    ])
  })
})
