import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { googleSheetsCreateContract } from '@/lib/api/contracts/google-sheets-create'
import { getValidationErrorMessage, parseRequest } from '@/lib/api/server'
import { validateAlphanumericId } from '@/lib/core/security/input-validation'
import { generateRequestId } from '@/lib/core/utils/request'

export const dynamic = 'force-dynamic'

const logger = createLogger('GoogleSheetsCreateSpreadsheetAPI')

/**
 * Create a Google Sheet and optionally place it in a Drive folder.
 * POST body: title, sheetTitles?, locale?, timeZone?, parentFolderId?, accessToken?
 * Google OAuth token must be in body.accessToken (executor overwrites Authorization for internal routes).
 */
export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  logger.info(`[${requestId}] Create spreadsheet request received`)

  try {
    const parsed = await parseRequest(googleSheetsCreateContract, request, undefined, {
      invalidJsonResponse: () => NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }),
      validationErrorResponse: (error) =>
        NextResponse.json({ error: getValidationErrorMessage(error) }, { status: 400 }),
    })
    if (!parsed.success) return parsed.response
    const body = parsed.data.body

    const token =
      typeof body.accessToken === 'string' && body.accessToken.trim()
        ? body.accessToken.trim()
        : null
    if (!token) {
      return NextResponse.json(
        { error: 'Google OAuth access token required (pass accessToken in request body)' },
        { status: 401 }
      )
    }

    const title = body.title

    const parentFolderId =
      typeof body.parentFolderId === 'string' && body.parentFolderId.trim()
        ? body.parentFolderId.trim()
        : undefined
    if (parentFolderId) {
      const folderValidation = validateAlphanumericId(parentFolderId, 'parentFolderId', 255)
      if (!folderValidation.isValid) {
        return NextResponse.json({ error: folderValidation.error }, { status: 400 })
      }
    }

    const sheetTitles = Array.isArray(body.sheetTitles)
      ? body.sheetTitles.map((t) => (typeof t === 'string' ? t : 'Sheet1'))
      : ['Sheet1']
    const createBody: Record<string, unknown> = {
      properties: { title },
      sheets: sheetTitles.map((t, i) => ({
        properties: { title: t, index: i },
      })),
    }
    if (typeof body.locale === 'string' && body.locale) {
      ;(createBody.properties as Record<string, string>).locale = body.locale
    }
    if (typeof body.timeZone === 'string' && body.timeZone) {
      ;(createBody.properties as Record<string, string>).timeZone = body.timeZone
    }

    const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createBody),
    })

    if (!createRes.ok) {
      const errData = await createRes.json().catch(() => ({}))
      const message =
        errData?.error?.message || createRes.statusText || 'Failed to create spreadsheet'
      logger.error(`[${requestId}] Sheets API create failed`, { status: createRes.status, message })
      return NextResponse.json(
        { error: message, ...(errData?.error ? { details: errData.error } : {}) },
        { status: createRes.status }
      )
    }

    const data = await createRes.json()
    const spreadsheetId = data.spreadsheetId

    if (parentFolderId && spreadsheetId) {
      const patchUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?addParents=${encodeURIComponent(parentFolderId)}`
      const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        body: '{}',
      })
      if (!patchRes.ok) {
        const errData = await patchRes.json().catch(() => ({}))
        logger.warn(`[${requestId}] Drive addParents failed; spreadsheet created in root`, {
          status: patchRes.status,
          error: errData?.error?.message,
        })
      }
    }

    const sheets =
      data.sheets?.map(
        (s: { properties?: { sheetId?: number; title?: string; index?: number } }) => ({
          sheetId: s.properties?.sheetId ?? 0,
          title: s.properties?.title ?? '',
          index: s.properties?.index ?? 0,
        })
      ) ?? []

    return NextResponse.json({
      output: {
        spreadsheetId: data.spreadsheetId ?? '',
        title: data.properties?.title ?? '',
        spreadsheetUrl: data.spreadsheetUrl ?? '',
        sheets,
      },
    })
  } catch (error) {
    logger.error(`[${requestId}] Create spreadsheet error`, error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
