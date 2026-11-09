import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { arenaClientUpdatedTasksContract } from '@/lib/api/contracts/tools/arena'
import { getValidationErrorMessage, parseRequest, validationErrorResponse } from '@/lib/api/server'
import { ArenaAuthError, arenaSolFetch } from '@/lib/arena/fetch'
import { resolveArenaCaller } from '@/lib/arena/resolve-caller'

const logger = createLogger('ArenaClientUpdatedTasksAPI')

export async function GET(req: NextRequest) {
  const parsed = await parseRequest(
    arenaClientUpdatedTasksContract,
    req,
    {},
    {
      validationErrorResponse: (error) =>
        validationErrorResponse(error, getValidationErrorMessage(error)),
    }
  )
  if (!parsed.success) return parsed.response
  const {
    workflowId,
    cid,
    period,
    pageNumber: resolvedPageNumber,
    pageSize: resolvedPageSize,
  } = parsed.data.query

  const resolved = await resolveArenaCaller(req, workflowId)
  if (!resolved.found) {
    return NextResponse.json(
      { error: 'Failed to get updated tasks', details: resolved.reason },
      { status: 400 }
    )
  }
  const { caller } = resolved

  try {
    const path = `/sol/v1/tasks/client/updated?cid=${encodeURIComponent(cid)}&period=${encodeURIComponent(period)}&pageNumber=${resolvedPageNumber}&pageSize=${resolvedPageSize}`
    logger.info('Arena client updated tasks request', { path, mode: caller.mode })

    const res = await arenaSolFetch({
      mode: caller.mode,
      userId: caller.userId,
      pathOrUrl: path,
      workflowId: caller.workflowId,
      executionId: caller.executionId,
      init: { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    })

    const responseData = await res.json()

    if (!res.ok) {
      return NextResponse.json(
        { error: 'Failed to get updated tasks', details: responseData },
        { status: res.status }
      )
    }

    return NextResponse.json(responseData, { status: res.status })
  } catch (error) {
    if (error instanceof ArenaAuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: 'Failed to get updated tasks', details: error },
      { status: 500 }
    )
  }
}
