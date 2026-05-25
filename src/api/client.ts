import {
  Configuration,
  AuthApi,
  EmojiApi,
  GuildApi,
  GuildInvitesApi,
  GuildRolesApi,
  MessageApi,
  SearchApi,
  UploadApi,
  UserApi,
  VoiceApi,
  WebhookApi,
  type DtoChannel,
  type DtoBannerUpload,
  type MessageCreateThreadRequest,
} from '@/client'
import JSONBig from 'json-bigint'
import axios from 'axios'
import { useAuthStore } from '@/stores/authStore'
import { getApiBaseUrl } from '@/lib/connectionConfig'
import { getDeviceKey } from '@/lib/deviceKey'
import { refreshAuthToken } from '@/lib/authRefresh'

const jsonBig = JSONBig({ storeAsString: true, useNativeBigInt: false })

export const axiosInstance = axios.create({
  // Serialize request bodies with BigInt support so Snowflake IDs don't lose precision
  transformRequest: [
    (data, headers) => {
      if (
        typeof data === 'object' &&
        data !== null &&
        !(data instanceof FormData) &&
        !(data instanceof ArrayBuffer) &&
        !(data instanceof Blob)
      ) {
        if (headers) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(headers as any)['Content-Type'] ??= 'application/json'
        }
        return JSON.stringify(data, (_, value) =>
          typeof value === 'bigint' ? value.toString() : value
        )
      }
      return data
    },
  ],
  transformResponse: [
    (data) => {
      if (typeof data === 'string') {
        try {
          return jsonBig.parse(data)
        } catch {
          return data
        }
      }
      return data
    },
  ],
})

axiosInstance.interceptors.request.use(async (cfg) => {
  const token = useAuthStore.getState().token
  if (token && cfg.headers) {
    cfg.headers.Authorization = `Bearer ${token}`
  }
  if (cfg.url?.includes('/user/me/settings') && cfg.headers) {
    cfg.headers['X-Device-Key'] = await getDeviceKey()
  }
  return cfg
})

axiosInstance.interceptors.response.use(
  (response) => response,
  async (error) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalRequest = error.config as any
    if (error.response?.status !== 401 || originalRequest._retry) {
      return Promise.reject(error)
    }

    const refreshToken = useAuthStore.getState().refreshToken
    if (!refreshToken) {
      return Promise.reject(error)
    }

    originalRequest._retry = true

    try {
      const newToken = await refreshAuthToken({ openModalOnFailure: true })
      // Strip the caller's AbortSignal so a React effect cleanup (which aborts
      // the original request's controller) cannot cancel this retry.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const retryConfig = { ...originalRequest } as any
      delete retryConfig.signal
      retryConfig.headers = { ...retryConfig.headers, Authorization: `Bearer ${newToken}` }
      return axiosInstance(retryConfig)
    } catch (refreshError) {
      return Promise.reject(refreshError)
    }
  },
)

const config = () =>
  new Configuration({
    basePath: getApiBaseUrl(),
  })

export const authApi = new AuthApi(config(), undefined, axiosInstance)
export const emojiApi = new EmojiApi(config(), undefined, axiosInstance)
export const guildApi = new GuildApi(config(), undefined, axiosInstance)
export const inviteApi = new GuildInvitesApi(config(), undefined, axiosInstance)
export const rolesApi = new GuildRolesApi(config(), undefined, axiosInstance)
export const messageApi = new MessageApi(config(), undefined, axiosInstance)
export const searchApi = new SearchApi(config(), undefined, axiosInstance)
export const uploadApi = new UploadApi(config(), undefined, axiosInstance)
export const userApi = new UserApi(config(), undefined, axiosInstance)
export const voiceApi = new VoiceApi(config(), undefined, axiosInstance)
export const webhookApi = new WebhookApi(config(), undefined, axiosInstance)

export async function createChannelThread(channelId: string | number, request: MessageCreateThreadRequest): Promise<DtoChannel> {
  const response = await axiosInstance.post<DtoChannel>(
    `${getApiBaseUrl()}/message/channel/${channelId}/thread`,
    request,
  )
  return response.data
}

export async function createProfileBannerUpload(file: File): Promise<DtoBannerUpload> {
  const response = await axiosInstance.post<DtoBannerUpload>(
    `${getApiBaseUrl()}/user/me/banner`,
    {
      content_type: file.type || 'application/octet-stream',
      file_size: file.size,
    },
  )
  return response.data
}

export interface ProfileBannerUploadCrop {
  x: number
  y: number
  width: number
  height: number
}

export async function uploadProfileBanner(userId: string | number, bannerId: string | number, file: Blob, crop?: ProfileBannerUploadCrop): Promise<void> {
  await axiosInstance.post(
    `${getApiBaseUrl()}/upload/profile-covers/${userId}/${bannerId}`,
    file,
    {
      headers: { 'Content-Type': 'application/octet-stream' },
      params: crop
        ? {
            crop_x: Math.round(crop.x),
            crop_y: Math.round(crop.y),
            crop_width: Math.round(crop.width),
            crop_height: Math.round(crop.height),
          }
        : undefined,
    },
  )
}

export async function saveUserPersonalNote(userId: string | number, note: string): Promise<void> {
  await axiosInstance.put(`${getApiBaseUrl()}/user/me/notes/${userId}`, { note })
}

export async function deleteUserPersonalNote(userId: string | number): Promise<void> {
  await axiosInstance.delete(`${getApiBaseUrl()}/user/me/notes/${userId}`)
}
