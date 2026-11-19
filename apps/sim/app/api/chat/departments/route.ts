import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import type { NextRequest } from 'next/server'
import { listAgentDepartmentsContract } from '@/lib/api/contracts/chats'
import { parseRequest } from '@/lib/api/server'
import { getSession } from '@/lib/auth'
import { verifyCronAuth } from '@/lib/auth/internal'
import { listAgentDepartments } from '@/lib/chat/arena-departments'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { createCodedErrorResponse, createSuccessResponse } from '@/app/api/workflows/utils'

const logger = createLogger('ChatDepartmentsAPI')

/**
 * GET /api/chat/departments
 * Returns active Arena agent departments.
 * Auth: logged-in Sim session, or `Authorization: Bearer <CRON_SECRET>` (same as agentsList).
 */
export const GET = withRouteHandler(async (request: NextRequest) => {
  try {
    const session = await getSession()
    if (!session?.user?.id) {
      const authError = verifyCronAuth(request, 'Agent departments list')
      if (authError) {
        return authError
      }
    }

    const parsed = await parseRequest(listAgentDepartmentsContract, request, {})
    if (!parsed.success) return parsed.response

    const departments = await listAgentDepartments()
    return createSuccessResponse({ departments })
  } catch (error) {
    logger.error('Error fetching agent departments:', error)
    return createCodedErrorResponse(getErrorMessage(error, 'Failed to fetch departments'), 500)
  }
})
