import { defineRouteContract } from '@/lib/api/contracts/types'

export const arenaThemeEventsContract = defineRouteContract({
  method: 'GET',
  path: '/api/users/me/settings/arena/events',
  response: { mode: 'stream' },
})
