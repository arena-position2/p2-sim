import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { type NextRequest, NextResponse } from 'next/server'
import { ArenaAuthError, arenaSolFetch } from '@/lib/arena/fetch'
import { resolveArenaCaller } from '@/lib/arena/resolve-caller'

const logger = createLogger('ArenaGetMyOverdueTasks')

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const workflowId = searchParams.get('workflowId')

  if (!workflowId) {
    return NextResponse.json({ error: 'Missing required field: workflowId' }, { status: 400 })
  }

  const resolved = await resolveArenaCaller(req, workflowId)
  if (!resolved.found) {
    return NextResponse.json(
      { error: 'Failed to get my overdue tasks', details: resolved.reason },
      { status: 400 }
    )
  }
  const { caller } = resolved

  try {
    const res = await arenaSolFetch({
      mode: caller.mode,
      userId: caller.userId,
      pathOrUrl: '/sol/v1/tasks/get-my-overdue-tasks',
      workflowId: caller.workflowId,
      executionId: caller.executionId,
      init: { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    })

    const responseData = await res.json()
    if (!res.ok) {
      return NextResponse.json(
        { error: 'Failed to get my overdue tasks', details: responseData },
        { status: res.status }
      )
    }

    return NextResponse.json(responseData, { status: res.status })
  } catch (error) {
    if (error instanceof ArenaAuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    const message = getErrorMessage(error, 'Failed to get my overdue tasks')
    logger.error('Get my overdue tasks failed', { message, workflowId })
    return NextResponse.json(
      { error: 'Failed to get my overdue tasks', details: message },
      { status: 500 }
    )
  }
}
