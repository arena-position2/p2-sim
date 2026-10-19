import { type NextRequest, NextResponse } from 'next/server'
import { ArenaAuthError, arenaSolFetch } from '@/lib/arena/fetch'
import { resolveArenaCaller } from '@/lib/arena/resolve-caller'

export async function POST(req: NextRequest) {
  const data = await req.json()
  const { workflowId, ...restData } = data
  const resolved = await resolveArenaCaller(req, workflowId)
  if (!resolved.found) {
    return NextResponse.json(
      { error: 'Failed to save summary', details: resolved.reason },
      { status: 400 }
    )
  }
  const { caller } = resolved

  try {
    const res = await arenaSolFetch({
      mode: caller.mode,
      userId: caller.userId,
      pathOrUrl: '/sol/v1/agentic/save-summary',
      workflowId: caller.workflowId,
      executionId: caller.executionId,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(restData),
      },
    })

    const responseData = await res.json()

    if (!res.ok) {
      return NextResponse.json(
        { error: 'Failed to save summary', details: responseData },
        { status: res.status }
      )
    }

    return NextResponse.json(responseData, { status: res.status })
  } catch (error) {
    if (error instanceof ArenaAuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json({ error: 'Failed to save summary', details: error }, { status: 500 })
  }
}
