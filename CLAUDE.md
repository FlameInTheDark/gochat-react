# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Projects

This repo contains two frontend projects:

| Project | Location | Status |
|---------|----------|--------|
| React (new) | repo root (`./`) | Active |
| SvelteKit (legacy) | `research/gochatui/` | Reference only |

---

## React Project (repo root)

### Commands

All commands run from the **repo root**:

```bash
bun run dev      # Start dev server at http://localhost:5173
bun run build    # Type-check + production build → dist/
bun run preview  # Preview production build
bun run lint     # ESLint check
```

No test runner is configured.

### Environment Variables

Copy `.env.example` to `.env`:

```
VITE_API_BASE_URL=http://localhost/api/v1
VITE_WEBSOCKET_URL=ws://localhost/ws/subscribe
```

### Tech Stack
- **React 19** + **TypeScript** (strict)
- **Vite 7** with `@vitejs/plugin-react`
- **Tailwind CSS v4** via `@tailwindcss/vite` (no tailwind.config.js — configured in `src/index.css` via `@theme`)
- **shadcn/ui** (New York style, Zinc dark palette) — components in `src/components/ui/`
- **React Router v7** (`createBrowserRouter`)
- **TanStack Query v5** for server state
- **Zustand v5** for client state
- **Axios** with BigInt-safe JSON parsing via `json-bigint`
- **`src/client/`** — local TypeScript API client generated from the Go backend OpenAPI spec (do not edit manually)

### Project Structure

```
src/
├── api/
│   └── client.ts          # Configured API instances (all 8 API classes)
├── components/
│   ├── ui/                # shadcn auto-generated — do not edit manually
│   ├── layout/
│   │   ├── AppShell.tsx   # Three-column chat shell
│   │   ├── ServerSidebar.tsx
│   │   ├── ChannelSidebar.tsx
│   │   └── UserArea.tsx
│   ├── chat/
│   │   ├── MessageList.tsx
│   │   ├── MessageItem.tsx
│   │   └── MessageInput.tsx
│   └── modals/
│       ├── CreateServerModal.tsx
│       ├── CreateChannelModal.tsx
│       ├── CreateCategoryModal.tsx
│       └── DeleteConfirmModal.tsx
├── hooks/
│   ├── useAuth.ts         # Auth state accessors
│   └── useWebSocket.ts    # WS connection lifecycle hook
├── services/
│   └── wsService.ts       # WebSocket singleton (auth, heartbeat, subscriptions)
├── stores/
│   ├── authStore.ts       # Zustand: token (persisted in localStorage) + currentUser
│   ├── messageStore.ts    # Zustand: messages keyed by channelId (string)
│   └── uiStore.ts         # Zustand: modal open state, context menu
├── client/                # Auto-generated API client (do not edit) — import via @/client
├── pages/
│   ├── LoginPage.tsx
│   ├── RegisterPage.tsx
│   ├── ConfirmPage.tsx
│   └── app/
│       ├── AppLayout.tsx   # Auth guard + AppShell wrapper
│       ├── ServerLayout.tsx
│       ├── ChannelPage.tsx
│       ├── MePage.tsx
│       └── DMPage.tsx
├── lib/
│   └── utils.ts           # shadcn cn() helper
├── types.ts               # Type aliases from @/client + ChannelType (= ModelChannelType) re-export
├── App.tsx                # Router + QueryClient + TooltipProvider
└── main.tsx
```

### Routing

```
/                     → LoginPage
/register             → RegisterPage
/confirm/:userId/:token → ConfirmPage
/app                  → AppLayout (auth-guarded)
  @me                 → MePage
  @me/:userId         → DMPage
  :serverId           → ServerLayout
    :channelId        → ChannelPage
```

### API Client (`src/api/client.ts`)

All API instances share one configured Axios instance with:
- BigInt-safe JSON parsing via `JSONBig({ storeAsString: true })`
- `Authorization: Bearer <token>` header from `localStorage.getItem('auth_token')`

Exports 10 API instances: `authApi`, `guildApi`, `inviteApi`, `rolesApi`, `messageApi`, `searchApi`, `uploadApi`, `userApi`, `voiceApi`, `webhookApi`.

**Important API naming conventions** (from OpenAPI generator):
- Methods take a single `requestParameters` object, not individual args
- **ID params are `string`** in the new client — pass string IDs directly, no casting needed
- Request body field is named `request` (not the old verbose name like `guildCreateGuildChannelRequest`)
- Example: `guildApi.guildGuildIdChannelGet({ guildId: serverId })`
- Example: `messageApi.messageChannelChannelIdPost({ channelId, request: { content } })`
- Example: `authApi.authLoginPost({ authLoginRequest: { email, password } })`

There is **no `userMeGet`** in the generated client — use a direct axios call to `GET /user/me` instead (see `AppLayout.tsx`).
Guilds for the current user: `userApi.userMeGuildsGet()` (no args needed).

### Vite/TypeScript Notes

- `erasableSyntaxOnly` is intentionally **disabled** because `src/client/base.ts` uses TypeScript parameter properties (`protected basePath: string` in constructor), which are not erasable syntax.

### State Management

- **authStore**: `token` (string | null), `user` (DtoUser | null). Token persisted to localStorage.
- **messageStore**: `messages` keyed by `channelId` as string. Real-time updates from WebSocket.
- **uiStore**: Modal open/close state. No persistence.

### WebSocket (`src/services/wsService.ts`)

Op codes:
- **Op 1** (server→client): hello → start heartbeat at `interval - 1000ms`
- **Op 2** (client→server): heartbeat / initial auth
- **Op 5** (client→server): subscribe to guild/channel events
- **Op 0** (server→client): dispatched events:
  - No `t`: new message → `messageStore.addMessage()`
  - `t=106`: channel created → `CustomEvent('ws:channel_create')`
  - `t=107`: message deleted → `messageStore.removeMessage()`
  - `t=109`: channel deleted → `CustomEvent('ws:channel_delete')`

### Auth Flow

1. Login → JWT returned → stored in `localStorage.auth_token` via `authStore.setToken()`
2. Axios interceptor adds `Authorization: Bearer` to all requests
3. `AppLayout.tsx` calls `GET /user/me` on mount; 401 redirects to `/`

### Key Conventions

- TypeScript strict mode throughout (no `any` except explicit casts where needed)
- Snowflake IDs come from API as `string` (due to JSONBig) but typed as `number` in DTO interfaces — use `String(id)` for React keys and store keys; API call **request param IDs are `string`** in `src/client/` so pass them directly (never `Number(id)` — JS float64 loses precision on 64-bit IDs)
- `DtoChannel.parent_id` is the category reference (not `category_id`)
- `DtoMessage.updated_at` is the timestamp field (no `created_at` on messages)
- `DtoUser` has `name` and `discriminator` but no `email`
- shadcn components live in `src/components/ui/` — install new ones with `bunx shadcn@latest add <name>`

---

## SvelteKit Legacy Project (`research/gochatui/`)

Kept for reference. Commands run from `research/gochatui/`:

```bash
npm run dev      # http://localhost:5173
npm run build
npm run check    # Svelte + TypeScript type checking
npm run lint
npm run format
```

See original architecture notes in git history.
