import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { ArenaAuthError, arenaSolFetch } from '@/lib/arena/fetch'
import { resolveArenaCaller } from '@/lib/arena/resolve-caller'
import { arenaBackendBaseUrl } from '@/lib/arena/tokens'

const logger = createLogger('ArenaConversationSummaryAPI')

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const workflowId = searchParams.get('workflowId')
  const taskId = searchParams.get('taskId')
  const headerToken =
    req.headers.get('authorisation')?.trim() ?? req.headers.get('authorization')?.trim()

  if (!workflowId && !headerToken) {
    return NextResponse.json(
      { error: 'Missing required field: workflowId or authorisation header' },
      { status: 400 }
    )
  }

  if (!taskId) {
    return NextResponse.json({ error: 'Missing required field: taskId' }, { status: 400 })
  }

  const path = `/sol/v1/agentic/conversation-summary?taskId=${encodeURIComponent(taskId)}`

  try {
    let res: Response

    if (workflowId) {
      const resolved = await resolveArenaCaller(req, workflowId)
      if (!resolved.found) {
        return NextResponse.json(
          { error: 'Failed to get conversation summary', details: resolved.reason },
          { status: 400 }
        )
      }
      const { caller } = resolved
      logger.info('Arena conversation summary request', { path, mode: caller.mode })
      res = await arenaSolFetch({
        mode: caller.mode,
        userId: caller.userId,
        pathOrUrl: path,
        workflowId: caller.workflowId,
        executionId: caller.executionId,
        init: { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      })
    } else {
      const url = `${arenaBackendBaseUrl()}${path}`
      logger.info('Arena conversation summary request (legacy header token)', { path })
      res = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          authorisation: headerToken || '',
        },
        cache: 'no-store',
      })
    }

    const responseData = await res.json()

    if (!res.ok) {
      return NextResponse.json(
        { error: 'Failed to get conversation summary', details: responseData },
        { status: res.status }
      )
    }

    return NextResponse.json(responseData, { status: res.status })
  } catch (error) {
    if (error instanceof ArenaAuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: 'Failed to get conversation summary', details: error },
      { status: 500 }
    )
  }
}
