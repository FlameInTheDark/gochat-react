import { useState, useEffect } from 'react'
import { X, Check, Minus, Ban } from 'lucide-react'
import { toast } from 'sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { useUiStore } from '@/stores/uiStore'
import { guildApi, rolesApi } from '@/api/client'
import type { DtoRole, GuildChannelRolePermission } from '@/client'
import { ChannelType } from '@/types'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────────────────────

type Section = 'overview' | 'permissions'

const NAV: { key: Section; label: string }[] = [
  { key: 'overview',    label: 'Overview' },
  { key: 'permissions', label: 'Permissions' },
]

type PermState = 'inherit' | 'allow' | 'deny'

// ── Channel-level permission definitions ──────────────────────────────────────
// Server-wide-only perms (Manage Server, Create Invite, Kick/Ban, etc.) are omitted
// here since channel overrides only make sense for channel-scoped capabilities.

interface ChannelPermDef { bit: number; label: string; desc: string }
interface ChannelPermCategory { category: string; perms: ChannelPermDef[] }

const CHANNEL_PERM_DEFS: ChannelPermCategory[] = [
  {
    category: 'General',
    perms: [
      { bit: 0,  label: 'View Channel',      desc: 'Allow members to see this channel.' },
      { bit: 1,  label: 'Manage Channel',    desc: 'Allow members to edit or delete this channel.' },
      { bit: 17, label: 'Manage Messages',   desc: "Allow members to delete others' messages and pin messages." },
    ],
  },
  {
    category: 'Text',
    perms: [
      { bit: 11, label: 'Send Messages',             desc: 'Allow members to send messages in this channel.' },
      { bit: 19, label: 'Read Message History',      desc: 'Allow members to read past messages in this channel.' },
      { bit: 14, label: 'Attach Files',              desc: 'Allow members to upload files and images.' },
      { bit: 15, label: 'Add Reactions',             desc: 'Allow members to add emoji reactions to messages.' },
      { bit: 16, label: 'Mention @roles',            desc: 'Allow members to @mention roles in messages.' },
      { bit: 12, label: 'Send in Threads',           desc: 'Allow members to send messages inside threads.' },
      { bit: 13, label: 'Create Threads',            desc: 'Allow members to create new thread conversations.' },
      { bit: 18, label: 'Manage Threads',            desc: 'Allow members to modify, archive, and delete threads.' },
    ],
  },
  {
    category: 'Voice',
    perms: [
      { bit: 20, label: 'Connect',         desc: 'Allow members to connect to this voice channel.' },
      { bit: 21, label: 'Speak',           desc: 'Allow members to transmit audio.' },
      { bit: 22, label: 'Video',           desc: 'Allow members to share video.' },
      { bit: 23, label: 'Mute Members',    desc: 'Allow members to server-mute others.' },
      { bit: 24, label: 'Deafen Members',  desc: 'Allow members to server-deafen others.' },
      { bit: 25, label: 'Move Members',    desc: 'Allow members to move others between channels.' },
    ],
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

const colorToHex = (color: number) =>
  `#${Math.max(0, color ?? 0).toString(16).padStart(6, '0')}`

function Toggle({
  value, onToggle, disabled,
}: { value: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        'relative w-10 h-5 rounded-full transition-colors shrink-0',
        value ? 'bg-green-500' : 'bg-muted',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform',
          value && 'translate-x-5',
        )}
      />
    </button>
  )
}

// ── 3-state permission button ─────────────────────────────────────────────────

function PermStateButton({
  state, target, onClick,
}: { state: PermState; target: PermState; onClick: () => void }) {
  const isActive = state === target
  const baseClass = 'w-7 h-7 flex items-center justify-center rounded transition-colors border'

  if (target === 'allow') {
    return (
      <button
        type="button"
        onClick={onClick}
        title="Allow"
        className={cn(
          baseClass,
          isActive
            ? 'bg-green-500 border-green-500 text-white'
            : 'border-border text-muted-foreground hover:border-green-500 hover:text-green-500',
        )}
      >
        <Check className="w-3.5 h-3.5" />
      </button>
    )
  }
  if (target === 'deny') {
    return (
      <button
        type="button"
        onClick={onClick}
        title="Deny"
        className={cn(
          baseClass,
          isActive
            ? 'bg-red-500 border-red-500 text-white'
            : 'border-border text-muted-foreground hover:border-red-500 hover:text-red-500',
        )}
      >
        <Ban className="w-3.5 h-3.5" />
      </button>
    )
  }
  // inherit
  return (
    <button
      type="button"
      onClick={onClick}
      title="Inherit from role"
      className={cn(
        baseClass,
        isActive
          ? 'bg-muted border-border text-foreground'
          : 'border-border text-muted-foreground hover:text-foreground',
      )}
    >
      <Minus className="w-3.5 h-3.5" />
    </button>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ChannelSettingsModal() {
  const channelId   = useUiStore((s) => s.channelSettingsChannelId)
  const guildId     = useUiStore((s) => s.channelSettingsGuildId)
  const close       = useUiStore((s) => s.closeChannelSettings)
  const queryClient = useQueryClient()
  const open = channelId !== null && guildId !== null

  const [section, setSection] = useState<Section>('overview')

  // Overview
  const [chanName,  setChanName]  = useState('')
  const [chanTopic, setChanTopic] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [savingOverview, setSavingOverview] = useState(false)

  // Permissions — left panel: selected role; right panel: per-permission states
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  // editAccept / editDeny bitmasks for the currently selected role's override
  const [editAccept, setEditAccept] = useState(0)
  const [editDeny,   setEditDeny]   = useState(0)
  const [savingPerms, setSavingPerms] = useState(false)

  // ── Queries ───────────────────────────────────────────────────────────────

  const { data: channel } = useQuery({
    queryKey: ['channel', guildId, channelId],
    queryFn: () =>
      guildApi.guildGuildIdChannelChannelIdGet({ guildId: guildId!, channelId: channelId! })
        .then((r) => r.data),
    enabled: open,
    staleTime: 30_000,
  })

  const { data: roles = [] } = useQuery<DtoRole[]>({
    queryKey: ['roles', guildId],
    queryFn: () => rolesApi.guildGuildIdRolesGet({ guildId: guildId! }).then((r) => r.data ?? []),
    enabled: open && !!guildId,
    staleTime: 60_000,
  })

  const { data: overrides = [] } = useQuery<GuildChannelRolePermission[]>({
    queryKey: ['channel-overrides', channelId],
    queryFn: () =>
      rolesApi.guildGuildIdChannelChannelIdRolesGet({ guildId: guildId!, channelId: channelId! })
        .then((r) => r.data ?? []),
    enabled: open && section === 'permissions',
    staleTime: 30_000,
  })

  // ── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (open && channel) {
      setChanName(channel.name ?? '')
      setChanTopic(channel.topic ?? '')
      setIsPrivate(channel.private ?? false)
    }
  }, [open, channel])

  // Reset state when channel changes or modal opens
  useEffect(() => {
    if (open) {
      setSection('overview')
      setSelectedRoleId(null)
    }
  }, [channelId, open])

  // Auto-select first role when entering permissions section
  useEffect(() => {
    if (section === 'permissions' && roles.length > 0 && selectedRoleId === null) {
      const first = roles[0]
      const rid = String(first.id)
      setSelectedRoleId(rid)
      const ov = overrides.find((o) => String(o.role_id) === rid)
      setEditAccept(Number(ov?.accept ?? 0))
      setEditDeny(Number(ov?.deny ?? 0))
    }
  }, [section, roles, selectedRoleId, overrides])

  // When overrides reload, refresh the editor for the selected role
  useEffect(() => {
    if (selectedRoleId) {
      const ov = overrides.find((o) => String(o.role_id) === selectedRoleId)
      setEditAccept(Number(ov?.accept ?? 0))
      setEditDeny(Number(ov?.deny ?? 0))
    }
  }, [overrides, selectedRoleId])

  // Reset roles selection when leaving permissions section
  useEffect(() => {
    if (section !== 'permissions') setSelectedRoleId(null)
  }, [section])

  // Escape to close
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, close])

  if (!open) return null

  // ── Permission helpers ────────────────────────────────────────────────────

  function getPermState(bit: number): PermState {
    const mask = 1 << bit
    if (editAccept & mask) return 'allow'
    if (editDeny   & mask) return 'deny'
    return 'inherit'
  }

  function setPermState(bit: number, target: PermState) {
    const mask = 1 << bit
    setEditAccept((a) => target === 'allow' ? (a | mask) : (a & ~mask))
    setEditDeny((d)   => target === 'deny'  ? (d | mask) : (d & ~mask))
  }

  function selectRole(role: DtoRole) {
    const rid = String(role.id)
    setSelectedRoleId(rid)
    const ov = overrides.find((o) => String(o.role_id) === rid)
    setEditAccept(Number(ov?.accept ?? 0))
    setEditDeny(Number(ov?.deny ?? 0))
  }

  // ── Handlers ─────────────────────────────────────────────────────────────

  const overviewChanged =
    (chanName.trim() !== '' && chanName.trim() !== channel?.name) ||
    chanTopic !== (channel?.topic ?? '') ||
    isPrivate !== (channel?.private ?? false)

  async function handleSaveOverview() {
    if (!guildId || !channelId || !chanName.trim()) return
    setSavingOverview(true)
    try {
      await guildApi.guildGuildIdChannelChannelIdPatch({
        guildId,
        channelId,
        req: { name: chanName.trim(), topic: chanTopic, private: isPrivate },
      })
      await queryClient.invalidateQueries({ queryKey: ['channels', guildId] })
      await queryClient.invalidateQueries({ queryKey: ['channel', guildId, channelId] })
      toast.success('Channel updated')
    } catch {
      toast.error('Failed to update channel')
    } finally {
      setSavingOverview(false)
    }
  }

  async function handleSavePermissions() {
    if (!guildId || !channelId || !selectedRoleId) return
    setSavingPerms(true)
    try {
      if (editAccept === 0 && editDeny === 0) {
        // All inherit → remove the override entirely
        await rolesApi.guildGuildIdChannelChannelIdRolesRoleIdDelete({
          guildId, channelId, roleId: selectedRoleId,
        })
      } else {
        await rolesApi.guildGuildIdChannelChannelIdRolesRoleIdPut({
          guildId, channelId, roleId: selectedRoleId,
          req: { accept: editAccept, deny: editDeny },
        })
      }
      await queryClient.invalidateQueries({ queryKey: ['channel-overrides', channelId] })
      toast.success('Permissions saved')
    } catch {
      toast.error('Failed to save permissions')
    } finally {
      setSavingPerms(false)
    }
  }

  async function handleResetPermissions(roleId: string) {
    if (!guildId || !channelId) return
    try {
      await rolesApi.guildGuildIdChannelChannelIdRolesRoleIdDelete({
        guildId, channelId, roleId,
      })
      await queryClient.invalidateQueries({ queryKey: ['channel-overrides', channelId] })
      if (selectedRoleId === roleId) {
        setEditAccept(0)
        setEditDeny(0)
      }
      toast.success('Override reset')
    } catch {
      toast.error('Failed to reset')
    }
  }

  // Check whether a role has any active override
  function hasOverride(roleId: string) {
    const ov = overrides.find((o) => String(o.role_id) === roleId)
    if (!ov) return false
    return (Number(ov.accept ?? 0) | Number(ov.deny ?? 0)) !== 0
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const isCategory = channel?.type === ChannelType.ChannelTypeGuildCategory
  const channelInitial = (channel?.name ?? '?').charAt(0).toUpperCase()
  const navLabel = isCategory ? `📁 ${channel?.name ?? 'Category Settings'}` : `# ${channel?.name ?? 'Channel Settings'}`

  return (
    <div className="fixed inset-0 z-50 flex bg-background/80 backdrop-blur-sm">
      <div className="flex w-full h-full overflow-hidden">

        {/* ── Left nav ── */}
        <div className="flex flex-1 justify-end bg-sidebar border-r border-sidebar-border">
          <div className="w-52 py-16 px-3 shrink-0">
            <p className="px-3 py-1 text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 truncate">
              {navLabel}
            </p>
            <div className="space-y-0.5">
              {NAV.map((s) => (
                <button
                  key={s.key}
                  onClick={() => setSection(s.key)}
                  className={cn(
                    'w-full text-left px-3 py-1.5 rounded text-sm transition-colors',
                    section === s.key
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Content ── */}
        <div className="flex flex-1 min-w-0">
          <div
            className={cn(
              'flex-1 py-16 overflow-y-auto',
              section === 'permissions' ? 'px-6' : 'px-10 max-w-2xl',
            )}
          >

            {/* ── Overview ── */}
            {section === 'overview' && (
              <div className="space-y-6">
                <h2 className="text-xl font-bold">{isCategory ? 'Category Overview' : 'Channel Overview'}</h2>

                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center text-muted-foreground text-lg font-bold shrink-0 select-none">
                    {channelInitial}
                  </div>
                  <div>
                    <p className="font-semibold">{channel?.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {isPrivate ? 'Private channel' : 'Public channel'}
                    </p>
                  </div>
                </div>

                <Separator />

                <div className="space-y-2">
                  <Label htmlFor="chan-name">Channel Name</Label>
                  <Input
                    id="chan-name"
                    value={chanName}
                    onChange={(e) => setChanName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveOverview() }}
                    placeholder="channel-name"
                  />
                </div>

                {!isCategory && (
                  <div className="space-y-2">
                    <Label htmlFor="chan-topic">Topic</Label>
                    <Input
                      id="chan-topic"
                      value={chanTopic}
                      onChange={(e) => setChanTopic(e.target.value)}
                      placeholder="Optional channel topic…"
                    />
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">
                      {isCategory ? 'Private Category' : 'Private Channel'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {isCategory
                        ? 'Only members with allowed roles can see this category and its channels'
                        : 'Only members with allowed roles can see this channel'}
                    </p>
                  </div>
                  <Toggle value={isPrivate} onToggle={() => setIsPrivate((v) => !v)} />
                </div>

                <Separator />

                <div className="space-y-2">
                  <Label>{isCategory ? 'Category ID' : 'Channel ID'}</Label>
                  <div className="flex gap-2 items-center">
                    <p className="text-sm text-muted-foreground bg-muted px-3 py-2 rounded-md flex-1 font-mono truncate">
                      {channelId}
                    </p>
                    <Button
                      variant="outline" size="sm"
                      onClick={() => { void navigator.clipboard.writeText(channelId ?? ''); toast.success('Copied!') }}
                    >
                      Copy
                    </Button>
                  </div>
                </div>

                <div className="flex justify-end pt-2">
                  <Button
                    onClick={() => void handleSaveOverview()}
                    disabled={savingOverview || !overviewChanged}
                  >
                    {savingOverview ? 'Saving…' : 'Save Changes'}
                  </Button>
                </div>
              </div>
            )}

            {/* ── Permissions ── two-panel layout ── */}
            {section === 'permissions' && (
              <div className="flex gap-0 h-full">

                {/* Left: Role list */}
                <div className="w-48 shrink-0 border-r border-border flex flex-col pr-2 mr-6">
                  <div className="mb-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Roles — {roles.length}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-1 leading-tight">
                      Select a role to manage its permissions in this channel.
                    </p>
                  </div>

                  <div className="space-y-0.5 flex-1 overflow-y-auto">
                    {roles.map((role) => {
                      const rid = String(role.id)
                      const hasOv = hasOverride(rid)
                      return (
                        <button
                          key={rid}
                          onClick={() => selectRole(role)}
                          className={cn(
                            'w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left transition-colors',
                            selectedRoleId === rid
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                          )}
                        >
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: colorToHex(role.color ?? 0) }}
                          />
                          <span className="truncate flex-1">{role.name}</span>
                          {hasOv && (
                            <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" title="Has overrides" />
                          )}
                        </button>
                      )
                    })}
                    {roles.length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-6">
                        No roles in this server
                      </p>
                    )}
                  </div>
                </div>

                {/* Right: Permission editor */}
                <div className="flex-1 min-w-0 overflow-y-auto">
                  {selectedRoleId ? (() => {
                    const selectedRole = roles.find((r) => String(r.id) === selectedRoleId)
                    return (
                      <div className="space-y-6 pb-8">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <h2 className="text-xl font-bold">
                              {selectedRole?.name ?? 'Role'} Permissions
                            </h2>
                            <p className="text-sm text-muted-foreground">
                              Override server-level permissions for this channel only.
                            </p>
                          </div>
                          {hasOverride(selectedRoleId) && (
                            <button
                              onClick={() => void handleResetPermissions(selectedRoleId)}
                              className="text-xs text-muted-foreground hover:text-destructive transition-colors shrink-0 mt-1"
                            >
                              Reset Overrides
                            </button>
                          )}
                        </div>

                        {/* Legend */}
                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1.5">
                            <span className="w-5 h-5 flex items-center justify-center rounded border border-border">
                              <Minus className="w-3 h-3" />
                            </span>
                            Inherit from role
                          </span>
                          <span className="flex items-center gap-1.5">
                            <span className="w-5 h-5 flex items-center justify-center rounded bg-green-500 text-white">
                              <Check className="w-3 h-3" />
                            </span>
                            Allow
                          </span>
                          <span className="flex items-center gap-1.5">
                            <span className="w-5 h-5 flex items-center justify-center rounded bg-red-500 text-white">
                              <Ban className="w-3 h-3" />
                            </span>
                            Deny
                          </span>
                        </div>

                        {/* Permission categories */}
                        {CHANNEL_PERM_DEFS.map((cat) => (
                          <div key={cat.category}>
                            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                              {cat.category}
                            </p>
                            <div className="rounded-lg border border-border overflow-hidden">
                              {cat.perms.map((perm, idx) => {
                                const isLast = idx === cat.perms.length - 1
                                const state = getPermState(perm.bit)
                                return (
                                  <div
                                    key={perm.bit}
                                    className={cn(
                                      'flex items-center gap-4 px-4 py-3 hover:bg-accent/20 transition-colors',
                                      !isLast && 'border-b border-border',
                                    )}
                                  >
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-medium">{perm.label}</p>
                                      <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                                        {perm.desc}
                                      </p>
                                    </div>
                                    {/* 3-state buttons */}
                                    <div className="flex items-center gap-1 shrink-0">
                                      <PermStateButton
                                        state={state} target="inherit"
                                        onClick={() => setPermState(perm.bit, 'inherit')}
                                      />
                                      <PermStateButton
                                        state={state} target="allow"
                                        onClick={() => setPermState(perm.bit, 'allow')}
                                      />
                                      <PermStateButton
                                        state={state} target="deny"
                                        onClick={() => setPermState(perm.bit, 'deny')}
                                      />
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ))}

                        {/* Save row */}
                        <div className="flex items-center justify-between pt-2 border-t border-border">
                          <p className="text-xs text-muted-foreground">
                            {editAccept === 0 && editDeny === 0
                              ? 'All permissions inherited — saving will remove any override.'
                              : 'Unsaved changes will take effect when saved.'}
                          </p>
                          <Button
                            onClick={() => void handleSavePermissions()}
                            disabled={savingPerms}
                          >
                            {savingPerms ? 'Saving…' : 'Save Changes'}
                          </Button>
                        </div>
                      </div>
                    )
                  })() : (
                    <div className="flex flex-col items-center justify-center h-64 text-center">
                      <p className="text-muted-foreground text-sm">
                        Select a role from the list to manage its permissions in this channel.
                      </p>
                    </div>
                  )}
                </div>

              </div>
            )}

          </div>

          {/* Close button */}
          <div className="pt-16 pr-6 shrink-0">
            <button
              onClick={close}
              className="w-9 h-9 rounded-full border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}
