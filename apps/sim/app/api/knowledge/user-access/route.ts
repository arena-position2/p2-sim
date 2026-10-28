import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { generateRequestId } from '@/lib/core/utils/request'
import { getUserKnowledgeBaseAccess } from '@/lib/knowledge/service'

const logger = createLogger('UserKnowledgeAccessAPI')

/**
 * GET /api/knowledge/user-access
 * Get knowledge bases that user has access to via workspace permissions
 * Returns all knowledge bases from all workspaces the user has access to
 * Returns minimal data with defaults for missing fields
 */
export async function GET(req: NextRequest) {
  const requestId = generateRequestId()

  try {
    const session = await getSession()
    if (!session?.user?.id) {
      logger.warn(`[${requestId}] Unauthorized knowledge base access attempt`)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const workspaceId = searchParams.get('workspaceId')

    const knowledgeBases = await getUserKnowledgeBaseAccess(session.user.id, workspaceId)

    return NextResponse.json({
      success: true,
      data: knowledgeBases,
    })
  } catch (error) {
    logger.error(`[${requestId}] Error fetching user knowledge base access`, error)
    return NextResponse.json({ error: 'Failed to fetch knowledge bases' }, { status: 500 })
  }
}
