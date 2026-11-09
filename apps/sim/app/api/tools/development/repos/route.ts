import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { developmentReposContract } from '@/lib/api/contracts/development-repos'
import { parseRequest } from '@/lib/api/server'
import { checkSessionOrInternalAuth } from '@/lib/auth/hybrid'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { listDevelopmentRepos } from '@/lib/development/list-development-repos'

const logger = createLogger('DevelopmentReposAPI')

export const GET = withRouteHandler(async (request: NextRequest) => {
  const auth = await checkSessionOrInternalAuth(request, { requireWorkflowId: false })
  if (!auth.success) {
    return NextResponse.json({ success: false, error: auth.error }, { status: 401 })
  }

  const parsed = await parseRequest(developmentReposContract, request, {})
  if (!parsed.success) return parsed.response

  logger.info('Listing development repositories')
  const result = await listDevelopmentRepos()

  if (!result.success) {
    return NextResponse.json(result, { status: 500 })
  }

  return NextResponse.json(result)
})
