/**
 * GoChat uses the go-snowflake library with its default epoch:
 * 2008-11-10 23:00:00 UTC → 1226372400000 ms since Unix epoch.
 *
 * Timestamp is stored in bits [63:22] (top 41 bits).
 * Formula: createdAt = EPOCH + (id >> 22)
 */
const SNOWFLAKE_EPOCH = 1226358000000n // 2008-11-10 23:00:00 UTC

export type SnowflakeLike = string | number | null | undefined

function toSnowflakeBigInt(id: SnowflakeLike): bigint | null {
  if (id === undefined || id === null) return null
  try {
    return BigInt(String(id))
  } catch {
    return null
  }
}

export function compareSnowflakes(a: SnowflakeLike, b: SnowflakeLike): number {
  const left = toSnowflakeBigInt(a)
  const right = toSnowflakeBigInt(b)

  if (left === null && right === null) return 0
  if (left === null) return -1
  if (right === null) return 1
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export function maxSnowflake(a: SnowflakeLike, b: SnowflakeLike): string | undefined {
  if (a == null && b == null) return undefined
  if (a == null) return String(b)
  if (b == null) return String(a)
  return compareSnowflakes(a, b) >= 0 ? String(a) : String(b)
}

/**
 * Extract the creation Date from a Snowflake ID.
 * Accepts the ID as a string, number, or undefined (undefined → epoch zero).
 * JSONBig stores IDs as strings at runtime even though DTO types say number.
 */
export function snowflakeToDate(id: string | number | undefined): Date {
  if (id === undefined || id === null) return new Date(0)
  try {
    const ms = (BigInt(String(id)) >> 22n) + SNOWFLAKE_EPOCH
    return new Date(Number(ms))
  } catch {
    return new Date(0)
  }
}

/**
 * Format a Snowflake-derived timestamp as a short time string (e.g., "3:42 PM").
 */
export function snowflakeToTime(id: string | number | undefined): string {
  return snowflakeToDate(id).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Format a Snowflake-derived date label, e.g. "Today", "Yesterday", or "January 1, 2025".
 */
export function snowflakeToDayLabel(id: string | number | undefined): string {
  const date = snowflakeToDate(id)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()

  if (sameDay(date, today)) return 'Today'
  if (sameDay(date, yesterday)) return 'Yesterday'
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}
