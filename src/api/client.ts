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
} from '@/client'
import JSONBig from 'json-bigint'
import axios from 'axios'
import { useAuthStore } from '@/stores/authStore'
import { getApiBaseUrl } from '@/lib/connectionConfig'

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

axiosInstance.interceptors.request.use((cfg) => {
  const token = useAuthStore.getState().token
  if (token && cfg.headers) {
    cfg.headers.Authorization = `Bearer ${token}`
  }
  return cfg
})

// --- JWT refresh on 401 ---
let isRefreshing = false
let refreshSubscribers: Array<{ resolve: (token: string) => void; reject: (err: unknown) => void }> = []

function onTokenRefreshed(token: string) {
  refreshSubscribers.forEach(({ resolve }) => resolve(token))
  refreshSubscribers = []
}

function onRefreshFailed(err: unknown) {
  refreshSubscribers.forEach(({ reject }) => reject(err))
  refreshSubscribers = []
}

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
      useAuthStore.getState().logout()
      return Promise.reject(error)
    }

    originalRequest._retry = true

    // Queue concurrent 401s until the refresh resolves.
    // The promise rejects if the refresh itself fails so callers don't hang.
    if (isRefreshing) {
      return new Promise<string>((resolve, reject) => {
        refreshSubscribers.push({ resolve, reject })
      }).then((newToken) => {
        // Strip the caller's AbortSignal so a React effect cleanup (which aborts
        // the original request's controller) cannot cancel this retry.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const retryConfig = { ...originalRequest } as any
        delete retryConfig.signal
        retryConfig.headers = { ...retryConfig.headers, Authorization: `Bearer ${newToken}` }
        return axiosInstance(retryConfig)
      })
    }

    isRefreshing = true

    try {
      const baseUrl = getApiBaseUrl()
      // Use plain axios (not axiosInstance) to avoid re-triggering this interceptor
      const res = await axios.get<{ token?: string; refresh_token?: string }>(
        `${baseUrl}/auth/refresh`,
        { headers: { Authorization: `Bearer ${refreshToken}` } },
      )

      const newToken = res.data.token
      const newRefreshToken = res.data.refresh_token
      if (!newToken) throw new Error('No token in refresh response')

      const store = useAuthStore.getState()
      store.setToken(newToken)
      if (newRefreshToken) store.setRefreshToken(newRefreshToken)

      isRefreshing = false
      onTokenRefreshed(newToken)

      // Strip the caller's AbortSignal so a React effect cleanup (which aborts
      // the original request's controller) cannot cancel this retry.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const retryConfig = { ...originalRequest } as any
      delete retryConfig.signal
      retryConfig.headers = { ...retryConfig.headers, Authorization: `Bearer ${newToken}` }
      return axiosInstance(retryConfig)
    } catch (refreshError) {
      isRefreshing = false
      onRefreshFailed(refreshError)
      useAuthStore.getState().logout()
      return Promise.reject(error)
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
