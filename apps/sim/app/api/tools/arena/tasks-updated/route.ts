import { type NextRequest, NextResponse } from 'next/server'
import { ArenaAuthError, arenaSolFetch } from '@/lib/arena/fetch'
import { resolveArenaCaller } from '@/lib/arena/resolve-caller'
import { env } from '@/lib/core/config/env'

export async function POST(req: NextRequest) {
  const data = await req.json()
  const { workflowId, ...restData } = data

  const resolved = await resolveArenaCaller(req, workflowId)
  if (!resolved.found) {
    return NextResponse.json(
      { error: 'Failed to create task', details: resolved.reason },
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
      pathOrUrl: '/sol/v1/tasks/updated',
      workflowId: caller.workflowId,
      executionId: caller.executionId,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    })

    const responseData = await res.json()
    responseData.redirectUrl = `${env.ARENA_FRONTEND_APP_URL}/arn/home?sysId=${responseData.sysId}`

    return NextResponse.json(responseData, { status: res.status })
  } catch (error) {
    if (error instanceof ArenaAuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json({ error: 'Failed to create task', details: error }, { status: 500 })
  }
}
