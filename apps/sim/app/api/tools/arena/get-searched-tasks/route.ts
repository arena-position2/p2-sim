import { type NextRequest, NextResponse } from 'next/server'
import { arenaGetSearchedTasksContract } from '@/lib/api/contracts/tools/arena'
import { getValidationErrorMessage, parseRequest, validationErrorResponse } from '@/lib/api/server'
import { ArenaAuthError, arenaSolFetch } from '@/lib/arena/fetch'
import { resolveArenaCaller } from '@/lib/arena/resolve-caller'

export async function POST(req: NextRequest) {
  const parsed = await parseRequest(
    arenaGetSearchedTasksContract,
    req,
    {},
    {
      validationErrorResponse: (error) =>
        validationErrorResponse(error, getValidationErrorMessage(error)),
    }
  )
  if (!parsed.success) return parsed.response
  const { workflowId, clientName, projectName, assigneeName, state } = parsed.data.body

  const resolved = await resolveArenaCaller(req, workflowId)
  if (!resolved.found) {
    return NextResponse.json(
      { error: 'Failed to fetch searched tasks', details: resolved.reason },
      { status: 400 }
    )
  }
  const { caller } = resolved

  try {
    const res = await arenaSolFetch({
      mode: caller.mode,
      userId: caller.userId,
      pathOrUrl: '/sol/v1/tasks/get-searched-tasks',
      workflowId: caller.workflowId,
      executionId: caller.executionId,
      init: {
        method: 'POST',
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientName: clientName?.trim() ?? '',
          projectName: projectName?.trim() ?? '',
          assigneeName: assigneeName?.trim() ?? '',
          state: state?.trim() ?? '',
        }),
      },
    })

    const responseData = await res.json()

    if (!res.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch searched tasks', details: responseData },
        { status: res.status }
      )
    }

    return NextResponse.json(responseData, { status: res.status })
  } catch (error) {
    if (error instanceof ArenaAuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: 'Failed to fetch searched tasks', details: error },
      { status: 500 }
    )
  }
}
