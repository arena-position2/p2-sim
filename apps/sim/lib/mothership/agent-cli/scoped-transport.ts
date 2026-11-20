import { NextRequest } from 'next/server'
import { V2_WORKFLOW_BILLING_EMAIL_HEADER } from '@/lib/api/contracts/v2/workflows'
import { markCopilotRequest } from '@/lib/api/server/routes/copilot-request'
import {
  dispatchInProcessV2Request,
  type MatchedRoute,
} from '@/lib/api/server/routes/in-process-transport'
import { tryMatchV2Route } from '@/lib/api/server/routes/v2-route-pattern'
import type { CopilotChatDelegationContext } from '@/lib/mothership/auth/application-delegation'
import { getUserEmailById } from '@/lib/users/queries'

/** Workflow routes are the ones that bill `X-Sim-Email`. */
function isWorkflowApiPath(pathname: string): boolean {
  return /^\/api\/(?:v2\/)?workflows(?:\/|$)/.test(pathname)
}

interface ScopedCliInvocation {
  admitRequest(
    request: NextRequest,
    route: MatchedRoute
  ): Response | undefined | Promise<Response | undefined>
}

/** Private admission uses only this validated in-process identity; public requests remain API-key authenticated. */
export function createScopedCliTransport(
  endpoint: string,
  invocation: CopilotChatDelegationContext | ScopedCliInvocation
): typeof fetch {
  const origin = new URL(endpoint).origin
  const scope = Object.freeze({ ...invocation })
  let billingEmail: Promise<string> | undefined
  const unavailable = () => Response.json({ error: 'CLI target is unavailable' }, { status: 400 })
  return async (input, init) => {
    let request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== origin || !url.pathname.startsWith('/api/v2/')) return unavailable()
    if (
      !('admitRequest' in scope) &&
      isWorkflowApiPath(url.pathname) &&
      !request.headers.has(V2_WORKFLOW_BILLING_EMAIL_HEADER)
    ) {
      billingEmail ??= getUserEmailById(scope.userId)
      const headers = new Headers(request.headers)
      headers.set(V2_WORKFLOW_BILLING_EMAIL_HEADER, await billingEmail)
      request = new Request(request, { headers })
    }
    const forwarded = new NextRequest(request)
    if ('admitRequest' in scope) {
      const matched = tryMatchV2Route(url.pathname)
      if (!matched) return unavailable()
      const denied = await scope.admitRequest(forwarded, matched)
      if (denied) return denied
    } else {
      markCopilotRequest(forwarded, scope)
    }
    return (
      (await dispatchInProcessV2Request(forwarded)) ??
      Response.json({ error: 'API route or method unavailable' }, { status: 404 })
    )
  }
}
