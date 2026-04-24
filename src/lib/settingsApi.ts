import { axiosInstance } from '@/api/client'
import type { ModelUserSettingsData, UserUserSettingsResponse } from '@/client'
import { queryClient } from '@/lib/queryClient'
import { getApiBaseUrl } from '@/lib/connectionConfig'
import { useFolderStore } from '@/stores/folderStore'

/**
 * Merge `patch` on top of the TQ cache, absorb any pending folder/channel save
 * (cancelling its timer), and POST everything in one request.
 *
 * Uses axiosInstance directly — not the generated client — because the folder
 * payload can contain BigInt Snowflake IDs that JSON.stringify() cannot handle.
 */
export async function saveSettings(patch: Partial<ModelUserSettingsData>): Promise<void> {
  const baseUrl = getApiBaseUrl()
  const existing = queryClient.getQueryData<ModelUserSettingsData>(['user-settings'])
    ?? (await axiosInstance.get<UserUserSettingsResponse>(`${baseUrl}/user/me/settings`)).data.settings
    ?? {}
  const merged = useFolderStore.getState().flushPendingInto({ ...existing, ...patch })
  await axiosInstance.post(`${baseUrl}/user/me/settings`, merged)
  queryClient.setQueryData(['user-settings'], merged)
}
