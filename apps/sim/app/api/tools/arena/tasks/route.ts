import { type NextRequest, NextResponse } from 'next/server'
import { arenaCreateTaskContract } from '@/lib/api/contracts/tools/arena'
import { getValidationErrorMessage, parseRequest, validationErrorResponse } from '@/lib/api/server'
import { ArenaAuthError, arenaSolFetch } from '@/lib/arena/fetch'
import { resolveArenaCaller } from '@/lib/arena/resolve-caller'
import { env } from '@/lib/core/config/env'

export async function POST(req: NextRequest) {
  const parsed = await parseRequest(
    arenaCreateTaskContract,
    req,
    {},
    {
      validationErrorResponse: (error) =>
        validationErrorResponse(error, getValidationErrorMessage(error)),
    }
  )
  if (!parsed.success) return parsed.response
  const { workflowId, ...restData } = parsed.data.body
  const resolved = await resolveArenaCaller(req, workflowId)
  if (!resolved.found) {
    return NextResponse.json(
      { error: 'Failed to create task', details: resolved.reason },
      { status: 400 }
    )
  }
  const { caller } = resolved
  const payload =
    caller.mode === 'human'
      ? { ...restData, createdBy: restData.createdBy ?? caller.email }
      : restData

  try {
    const res = await arenaSolFetch({
      mode: caller.mode,
      userId: caller.userId,
      pathOrUrl: '/sol/v1/tasks',
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
