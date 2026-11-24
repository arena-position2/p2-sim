import { type Context, context, SpanStatusCode, trace } from '@opentelemetry/api'
import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { CopilotLeg } from '@/lib/mothership/observability/trace-attribute-values'
import { TraceAttr } from '@/lib/mothership/observability/trace-attributes'
import { isActionableErrorStatus, markSpanForError } from '@/lib/mothership/request/otel'
import { traceHeaders } from '@/lib/mothership/request/worker/propagation'
import {
  isCopilotApiKeyFailoverNetworkError,
  isCopilotApiKeyFailoverStatus,
  listCopilotApiKeys,
  stripCopilotApiKeyHeader,
} from '@/lib/mothership/server/copilot-api-keys'

const logger = createLogger('CopilotFetchWorker')

// Lazy tracer resolution: module-level `trace.getTracer()` can be evaluated
// before `instrumentation-node.ts` installs the TracerProvider under
// Next.js 16 + Turbopack dev, freezing a NoOp tracer and silently dropping
// every outbound Sim → worker span. Resolving per-call avoids the race.
const getTracer = () => trace.getTracer('sim-copilot-http', '1.0.0')

interface OutboundFetchOptions extends RequestInit {
  otelContext?: Context
  spanName?: string
  operation?: string
  attributes?: Record<string, string | number | boolean>
}

/**
 * Perform an outbound Sim → worker fetch wrapped in an OTel child span so each
 * call shows up as a distinct segment in Jaeger, and propagates the W3C
 * traceparent so the worker's span joins the same trace.
 *
 * When the request includes an `x-api-key` header and multiple copilot keys
 * are configured (`COPILOT_API_KEY`, `COPILOT_API_KEY_2`), automatically
 * retries with the backup key on auth, rate-limit, and transient server errors.
 */
export async function fetchWorker(
  url: string,
  options: OutboundFetchOptions = {}
): Promise<Response> {
  const {
    otelContext,
    spanName,
    operation,
    attributes,
    headers: providedHeaders,
    ...init
  } = options

  const parsed = safeParseUrl(url)
  const pathname = parsed?.pathname ?? url
  const method = (init.method ?? 'GET').toUpperCase()
  const parentContext = otelContext ?? context.active()

  const span = getTracer().startSpan(
    spanName ?? `sim → worker ${pathname}`,
    {
      attributes: {
        [TraceAttr.HttpMethod]: method,
        [TraceAttr.HttpUrl]: url,
        [TraceAttr.HttpTarget]: pathname,
        [TraceAttr.NetPeerName]: parsed?.host ?? '',
        [TraceAttr.CopilotLeg]: CopilotLeg.SimToWorker,
        ...(operation ? { [TraceAttr.CopilotOperation]: operation } : {}),
        ...(attributes ?? {}),
      },
    },
    parentContext
  )

  const activeContext = trace.setSpan(parentContext, span)
  const propagatedHeaders = traceHeaders({}, activeContext)
  const mergedHeaders = {
    ...(providedHeaders as Record<string, string> | undefined),
    ...propagatedHeaders,
  }

  const headerRecord = mergedHeaders as Record<string, string>
  const copilotKeys = listCopilotApiKeys()

  const start = performance.now()

  const executeFetch = (headers: Record<string, string>) =>
    context.with(activeContext, () =>
      fetch(url, {
        ...init,
        method,
        headers,
      })
    )

  try {
    const response =
      copilotKeys.length > 0
        ? await fetchWorkerWithCopilotKeyFailover(executeFetch, headerRecord, copilotKeys)
        : await executeFetch(mergedHeaders)

    const elapsedMs = performance.now() - start
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    span.setAttribute(TraceAttr.HttpStatusCode, response.status)
    span.setAttribute(TraceAttr.HttpResponseHeadersMs, Math.round(elapsedMs))
    if (contentLength > 0) {
      span.setAttribute(TraceAttr.HttpResponseContentLength, contentLength)
    }
    // Only mark ERROR for actionable status codes. 4xx that represent
    // normal auth/validation rejections (400/401/403/404/405/422/etc.)
    // stay UNSET so error dashboards don't drown in expected rejection
    // paths (`isActionableErrorStatus`: 5xx + 402/409/429).
    if (isActionableErrorStatus(response.status)) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `HTTP ${response.status}`,
      })
    } else {
      span.setStatus({ code: SpanStatusCode.OK })
    }
    return response
  } catch (error) {
    span.setAttribute(TraceAttr.HttpResponseHeadersMs, Math.round(performance.now() - start))
    markSpanForError(span, error)
    throw error
  } finally {
    span.end()
  }
}

async function fetchWorkerWithCopilotKeyFailover(
  executeFetch: (headers: Record<string, string>) => Promise<Response>,
  headers: Record<string, string>,
  keys: string[]
): Promise<Response> {
  const baseHeaders = stripCopilotApiKeyHeader(headers)
  let lastResponse: Response | undefined

  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    const isLastKey = index === keys.length - 1

    try {
      const response = await executeFetch({ ...baseHeaders, 'x-api-key': key })
      const shouldFailover = !isLastKey && isCopilotApiKeyFailoverStatus(response.status)

      if (!shouldFailover) {
        if (index > 0 && !isCopilotApiKeyFailoverStatus(response.status)) {
          logger.info('Copilot API key failover succeeded', {
            keyIndex: index + 1,
            totalKeys: keys.length,
            status: response.status,
          })
        } else if (index > 0 && isCopilotApiKeyFailoverStatus(response.status)) {
          logger.error('Copilot API key failover exhausted: all keys rejected', {
            keyIndex: index + 1,
            totalKeys: keys.length,
            status: response.status,
          })
        }
        return response
      }

      logger.warn('Copilot API key failover: trying next key', {
        keyIndex: index + 1,
        totalKeys: keys.length,
        status: response.status,
      })
      lastResponse = response
    } catch (error) {
      const shouldFailover = !isLastKey && isCopilotApiKeyFailoverNetworkError(error)
      if (!shouldFailover) {
        throw error
      }

      logger.warn('Copilot API key failover: retrying after network error', {
        keyIndex: index + 1,
        totalKeys: keys.length,
        error: getErrorMessage(error),
      })
    }
  }

  return lastResponse!
}

function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
