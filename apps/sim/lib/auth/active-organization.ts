import { headers } from 'next/headers'
import { auth } from './auth'

export async function setActiveOrganizationForCurrentSession(
  organizationId: string | null
): Promise<void> {
  await (
    auth.api as unknown as {
      setActiveOrganization: (input: {
        body: { organizationId: string | null }
        headers: Awaited<ReturnType<typeof headers>>
      }) => Promise<unknown>
    }
  ).setActiveOrganization({
    body: { organizationId },
    headers: await headers(),
  })
}
