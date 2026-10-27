import { createHmac } from 'node:crypto'
import { env } from '@/lib/core/config/env'
import { isSimCloudHosted } from '@/lib/core/config/env-flags'
import type { SimConnection } from '@/lib/mothership/generated/sim-transport'

/**
 * Server-owned topology; no browser or model input chooses a callback destination.
 *
 * Direct callbacks are only for Sim Cloud. Arena sets `isHosted` for product
 * features, but Cloud mothership still treats this process as a customer and
 * rejects `direct` with "Customer requests require outbound Sim transport".
 */
export function getSimConnection(): SimConnection {
  const mode = env.MOTHERSHIP_SIM_TRANSPORT ?? (isSimCloudHosted ? 'direct' : 'checkpoint')
  if (mode === 'direct') return { mode }
  return {
    mode,
    channelId: createHmac('sha256', env.INTERNAL_API_SECRET)
      .update('mothership:sim-transport:v1')
      .digest('hex'),
  }
}
