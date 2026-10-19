import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { ArenaAuthError, arenaSolFetch } from '@/lib/arena/fetch'
import { resolveArenaCaller } from '@/lib/arena/resolve-caller'

const logger = createLogger('ArenaCommentsAPI')

export async function POST(req: NextRequest) {
  const data = await req.json()
  const { workflowId, ...restData } = data
  const resolved = await resolveArenaCaller(req, workflowId)
  if (!resolved.found) {
    logger.error('Add comment failed: Arena caller not resolved', {
      reason: resolved.reason,
      workflowId,
    })
    return NextResponse.json(
      { error: 'Failed to add comment', details: resolved.reason },
      { status: 400 }
    )
  }
  const { caller } = resolved
  const payload =
    caller.mode === 'automation' ? { ...restData } : { ...restData, createdBy: caller.email }

  try {
    const res = await arenaSolFetch({
      mode: caller.mode,
      userId: caller.userId,
      pathOrUrl: '/project/commentattachmentservice/addcomment',
      workflowId: caller.workflowId,
      executionId: caller.executionId,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          accept: '*/*',
        },
        body: JSON.stringify(payload),
      },
    })

    const responseData = await res.json()

    if (!res.ok) {
      logger.error('Add comment failed: Arena API returned error', {
        status: res.status,
        statusText: res.statusText,
        responseData,
        workflowId,
      })
      return NextResponse.json(
        { error: 'Failed to add comment', details: responseData },
        { status: res.status }
      )
    }

    return NextResponse.json(responseData, { status: res.status })
  } catch (error) {
    if (error instanceof ArenaAuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    logger.error('Add comment failed: unexpected error', { error, workflowId })
    return NextResponse.json({ error: 'Failed to add comment', details: error }, { status: 500 })
  }
}
