export type UsageUpgradeAction = 'upgrade_plan' | 'increase_limit'

/**
 * Builds the `<usage_upgrade>` tag rendered by the mothership chat UI
 * ({@link UsageUpgradeDisplay}). Shared by the SSE billing path, the pre-stream
 * JSON 402 gate, and the client optimistic handler so all surfaces emit the
 * same wire shape.
 */
export function buildUsageUpgradeContent(
  message: string,
  options?: { scope?: string; action?: UsageUpgradeAction }
): string {
  const action =
    options?.action ?? (options?.scope === 'member' ? 'increase_limit' : 'upgrade_plan')
  return `<usage_upgrade>${JSON.stringify({
    reason: 'usage_limit',
    action,
    message,
  })}</usage_upgrade>`
}
