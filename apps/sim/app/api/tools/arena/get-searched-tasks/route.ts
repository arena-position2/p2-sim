import { type NextRequest, NextResponse } from 'next/server'
import { ArenaAuthError, arenaSolFetch } from '@/lib/arena/fetch'
import { resolveArenaCaller } from '@/lib/arena/resolve-caller'

interface GetSearchedTasksBody {
  workflowId?: string
  clientName?: string
  projectName?: string
  assigneeName?: string
  state?: string
}

export async function POST(req: NextRequest) {
  const data = (await req.json()) as GetSearchedTasksBody
  const { workflowId, clientName, projectName, assigneeName, state } = data

  if (!workflowId) {
    return NextResponse.json({ error: 'Missing required field: workflowId' }, { status: 400 })
  }

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
