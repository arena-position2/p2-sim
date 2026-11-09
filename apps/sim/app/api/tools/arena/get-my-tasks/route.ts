import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { type NextRequest, NextResponse } from 'next/server'
import { arenaGetMyTasksContract } from '@/lib/api/contracts/tools/arena'
import { getValidationErrorMessage, parseRequest, validationErrorResponse } from '@/lib/api/server'
import { ArenaAuthError, arenaSolFetch } from '@/lib/arena/fetch'
import { resolveArenaCaller } from '@/lib/arena/resolve-caller'

const logger = createLogger('ArenaGetMyTasks')

export async function GET(req: NextRequest) {
  const parsed = await parseRequest(
    arenaGetMyTasksContract,
    req,
    {},
    {
      validationErrorResponse: (error) =>
        validationErrorResponse(error, getValidationErrorMessage(error)),
    }
  )
  if (!parsed.success) return parsed.response
  const { workflowId, withinMinutes } = parsed.data.query

  const resolved = await resolveArenaCaller(req, workflowId)
  if (!resolved.found) {
    return NextResponse.json(
      { error: 'Failed to get my tasks', details: resolved.reason },
      { status: 400 }
    )
  }
  const { caller } = resolved

  try {
    const path =
      withinMinutes !== undefined
        ? `/sol/v1/tasks/get-my-tasks?withinMinutes=${encodeURIComponent(String(withinMinutes))}`
        : '/sol/v1/tasks/get-my-tasks'

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
        { error: 'Failed to get my tasks', details: responseData },
        { status: res.status }
      )
    }

    return NextResponse.json(responseData, { status: res.status })
  } catch (error) {
    if (error instanceof ArenaAuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    const message = getErrorMessage(error, 'Failed to get my tasks')
    logger.error('Get my tasks failed', { message, workflowId })
    return NextResponse.json({ error: 'Failed to get my tasks', details: message }, { status: 500 })
  }
}
