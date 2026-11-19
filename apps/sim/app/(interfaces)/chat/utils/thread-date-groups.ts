export type ThreadDateGroup = 'Pinned' | 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older'

const GROUP_ORDER: Exclude<ThreadDateGroup, 'Pinned'>[] = [
  'Today',
  'Yesterday',
  'Previous 7 days',
  'Older',
]

export function getThreadDateGroup(updatedAt: string | Date): Exclude<ThreadDateGroup, 'Pinned'> {
  const date = typeof updatedAt === 'string' ? new Date(updatedAt) : updatedAt
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)
  const startOfWeek = new Date(startOfToday)
  startOfWeek.setDate(startOfWeek.getDate() - 7)

  if (date >= startOfToday) return 'Today'
  if (date >= startOfYesterday) return 'Yesterday'
  if (date >= startOfWeek) return 'Previous 7 days'
  return 'Older'
}

export function groupThreadsByDate<T extends { updatedAt: string; pinnedAt?: string | null }>(
  threads: T[]
): Array<{ label: ThreadDateGroup; threads: T[] }> {
  const pinned = threads.filter((t) => t.pinnedAt)
  const unpinned = threads.filter((t) => !t.pinnedAt)

  const buckets = new Map<Exclude<ThreadDateGroup, 'Pinned'>, T[]>()
  for (const group of GROUP_ORDER) {
    buckets.set(group, [])
  }

  for (const thread of unpinned) {
    const group = getThreadDateGroup(thread.updatedAt)
    buckets.get(group)?.push(thread)
  }

  const result: Array<{ label: ThreadDateGroup; threads: T[] }> = []

  if (pinned.length > 0) {
    result.push({ label: 'Pinned', threads: pinned })
  }

  for (const group of GROUP_ORDER) {
    const items = buckets.get(group) ?? []
    if (items.length > 0) {
      result.push({ label: group, threads: items })
    }
  }

  return result
}
