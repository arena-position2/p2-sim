// Sim OTel bootstrap. Filter by `mothership.origin` or span-name
// prefix (`sim-mothership:` / `go-mothership:`) to separate the two
// halves of a mothership trace in the OTLP backend.

import { hostname } from 'node:os'
import type { Attributes, Context, Link, SpanKind } from '@opentelemetry/api'
import { DiagConsoleLogger, DiagLogLevel, diag, TraceFlags, trace } from '@opentelemetry/api'
import type {
  ReadableSpan,
  Sampler,
  SamplingResult,
  Span,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { createLogger } from '@sim/logger'
import { TraceAttr } from '@/lib/mothership/generated/trace-attributes-v1'
import { env } from './lib/core/config/env'
import { parseOtlpHeaders } from './lib/monitoring/otlp'

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR)

const logger = createLogger('OTelInstrumentation')

const MOTHERSHIP_ORIGIN = 'sim-mothership' as const
const SPAN_NAME_PREFIX = `${MOTHERSHIP_ORIGIN}: `

const SERVICE_INSTANCE_SLUG = 'sim' as const

const DEFAULT_TELEMETRY_CONFIG = {
  endpoint: env.TELEMETRY_ENDPOINT || 'https://telemetry.simstudio.ai/v1/traces',
  serviceName: 'mothership',
  serviceVersion: '0.1.0',
  serverSide: { enabled: true },
  batchSettings: {
    maxQueueSize: 2048,
    maxExportBatchSize: 512,
    scheduledDelayMillis: 5000,
    exportTimeoutMillis: 30000,
  },
}

// Allowlist of span-name prefixes exported from this process.
// Non-mothership code (workflow executor, block runtime, framework
// noise) is dropped. Broaden carefully — `http.` etc. would reopen
// the firehose.
const ALLOWED_SPAN_PREFIXES = ['gen_ai.', 'copilot.', 'sim →', 'sim.', 'tool.execute']

function isBusinessSpan(spanName: string): boolean {
  return ALLOWED_SPAN_PREFIXES.some((prefix) => spanName.startsWith(prefix))
}

// Append `/v1/traces` to the OTLP base URL unless already present.
// The HTTP exporter doesn't auto-suffix the signal path even though
// the spec says the env var is a base URL.
function normalizeOtlpTracesUrl(url: string): string {
  if (!url) return url
  try {
    const u = new URL(url)
    if (u.pathname.endsWith('/v1/traces')) return url
    const base = url.replace(/\/$/, '')
    return `${base}/v1/traces`
  } catch {
    return url
  }
}

// Metrics counterpart to `normalizeOtlpTracesUrl`. Operates on the parsed
// pathname (not a raw string suffix) so query strings and trailing slashes
// don't corrupt the result: swap a `/v1/traces` suffix for `/v1/metrics`,
// otherwise append `/v1/metrics`.
function normalizeOtlpMetricsUrl(url: string): string {
  if (!url) return url
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/$/, '')
    if (path.endsWith('/v1/metrics')) return url
    u.pathname = path.endsWith('/v1/traces')
      ? path.replace(/\/v1\/traces$/, '/v1/metrics')
      : `${path}/v1/metrics`
    return u.toString()
  } catch {
    return url
  }
}

// Logs counterpart to `normalizeOtlpMetricsUrl` — same parsed-pathname
// handling, targeting the /v1/logs signal path.
function normalizeOtlpLogsUrl(url: string): string {
  if (!url) return url
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/$/, '')
    if (path.endsWith('/v1/logs')) return url
    u.pathname = path.endsWith('/v1/traces')
      ? path.replace(/\/v1\/traces$/, '/v1/logs')
      : `${path}/v1/logs`
    return u.toString()
  } catch {
    return url
  }
}

// deployment.environment in the GO value space (dev | staging | prod) without
// any new infra env var. Every deployed Sim tier already gets
// APPCONFIG_ENVIRONMENT = the infra env name (dev | staging | production), so we
// reuse it and map production -> prod to match Go's `OTEL_DEPLOYMENT_ENVIRONMENT`
// (and thus a single Grafana $env filter spans Sim + Go). Returns undefined when
// unset (local dev) so the OTEL_/NODE_ENV fallbacks still apply.
function deploymentEnvFromAppConfig(v: string | undefined): string | undefined {
  if (!v) return undefined
  return v === 'production' ? 'prod' : v
}

// Sampling ratio from env (mirrors Go's `samplerFromEnv`); fallback
// is 100% everywhere. Retention caps cost, not sampling.
function resolveSamplingRatio(_isLocalEndpoint: boolean): number {
  const raw = process.env.TELEMETRY_SAMPLING_RATIO || process.env.OTEL_TRACES_SAMPLER_ARG || ''
  if (raw) {
    const parsed = Number.parseFloat(raw)
    if (Number.isFinite(parsed)) {
      if (parsed <= 0) return 0
      if (parsed >= 1) return 1
      return parsed
    }
  }
  return 1.0
}

// Tags allowed spans with `mothership.origin` and prepends
// `sim-mothership:` to the span name so backends can visually split
// the two halves even when service.name is shared.
class MothershipOriginSpanProcessor implements SpanProcessor {
  onStart(span: Span): void {
    const name = span.name
    if (!isBusinessSpan(name)) {
      return
    }
    span.setAttribute(TraceAttr.MothershipOrigin, MOTHERSHIP_ORIGIN)
    if (!name.startsWith(SPAN_NAME_PREFIX)) {
      span.updateName(`${SPAN_NAME_PREFIX}${name}`)
    }
  }
  onEnd(_span: ReadableSpan): void {}
  shutdown(): Promise<void> {
    return Promise.resolve()
  }
  forceFlush(): Promise<void> {
    return Promise.resolve()
  }
}

async function initializeOpenTelemetry() {
  try {
    if (env.NEXT_TELEMETRY_DISABLED === '1' || process.env.NEXT_TELEMETRY_DISABLED === '1') {
      logger.info('OpenTelemetry disabled via NEXT_TELEMETRY_DISABLED=1')
      return
    }

    let telemetryConfig
    try {
      telemetryConfig = (await import('./telemetry.config')).default
    } catch {
      telemetryConfig = DEFAULT_TELEMETRY_CONFIG
    }

    // Prefer the OTel spec env var, fall back to legacy TELEMETRY_ENDPOINT.
    const resolvedEndpoint =
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      process.env.TELEMETRY_ENDPOINT ||
      env.TELEMETRY_ENDPOINT ||
      telemetryConfig.endpoint
    telemetryConfig = {
      ...telemetryConfig,
      endpoint: resolvedEndpoint,
      serviceName: 'mothership',
    }

    if (telemetryConfig.serverSide?.enabled === false) {
      logger.info('Server-side OpenTelemetry disabled in config')
      return
    }

    logger.info('OpenTelemetry init', {
      endpoint: telemetryConfig.endpoint,
      serviceName: telemetryConfig.serviceName,
      origin: MOTHERSHIP_ORIGIN,
    })

    const { NodeSDK } = await import('@opentelemetry/sdk-node')
    const { defaultResource, resourceFromAttributes } = await import('@opentelemetry/resources')
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT } = await import(
      '@opentelemetry/semantic-conventions/incubating'
    )
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http')
    const { PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics')
    const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-http')
    const { BatchLogRecordProcessor } = await import('@opentelemetry/sdk-logs')
    const { BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-node')
    const { TraceIdRatioBasedSampler, SamplingDecision } = await import(
      '@opentelemetry/sdk-trace-base'
    )

    // Drops Next framework spans, inherits SAMPLED from business
    // parents, and re-samples business roots fresh (don't delegate to
    // ParentBased — its unsampled-parent path is AlwaysOff by default).
    const createBusinessSpanSampler = (rootRatioSampler: Sampler): Sampler => ({
      shouldSample(
        context: Context,
        traceId: string,
        spanName: string,
        spanKind: SpanKind,
        attributes: Attributes,
        links: Link[]
      ): SamplingResult {
        if (attributes['next.span_type']) {
          return { decision: SamplingDecision.NOT_RECORD }
        }

        const parentSpanContext = trace.getSpanContext(context)
        const parentIsSampled =
          !!parentSpanContext &&
          (parentSpanContext.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED

        if (parentIsSampled) {
          return { decision: SamplingDecision.RECORD_AND_SAMPLED }
        }

        if (isBusinessSpan(spanName)) {
          return rootRatioSampler.shouldSample(
            context,
            traceId,
            spanName,
            spanKind,
            attributes,
            links
          )
        }

        return { decision: SamplingDecision.NOT_RECORD }
      },
      toString(): string {
        return `BusinessSpanSampler{rootSampler=${rootRatioSampler.toString()}}`
      },
    })

    const otlpHeaders = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS || '')
    const exporterUrl = normalizeOtlpTracesUrl(telemetryConfig.endpoint)

    const exporter = new OTLPTraceExporter({
      url: exporterUrl,
      headers: otlpHeaders,
      timeoutMillis: Math.min(telemetryConfig.batchSettings.exportTimeoutMillis, 10000),
      keepAlive: false,
    })

    // Surface export failures (BatchSpanProcessor swallows them otherwise).
    const origExport = exporter.export.bind(exporter)
    exporter.export = (spans, resultCallback) => {
      origExport(spans, (result) => {
        if (result?.code !== 0) {
          logger.error('Exporter export failed', {
            endpoint: telemetryConfig.endpoint,
            resultCode: result?.code,
            error: result?.error?.message,
            spanCount: spans.length,
          })
        }
        resultCallback(result)
      })
    }

    const batchProcessor = new BatchSpanProcessor(exporter, {
      maxQueueSize: telemetryConfig.batchSettings.maxQueueSize,
      maxExportBatchSize: telemetryConfig.batchSettings.maxExportBatchSize,
      scheduledDelayMillis: telemetryConfig.batchSettings.scheduledDelayMillis,
      exportTimeoutMillis: telemetryConfig.batchSettings.exportTimeoutMillis,
    })

    // Metrics (hosted-key counters/histograms) share the trace endpoint and
    // headers — only the signal path differs. Unlike spans these aren't sampled.
    const metricReader = new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: normalizeOtlpMetricsUrl(telemetryConfig.endpoint),
        headers: otlpHeaders,
        timeoutMillis: Math.min(telemetryConfig.batchSettings.exportTimeoutMillis, 10000),
        keepAlive: false,
      }),
      exportIntervalMillis: 60000,
    })

    // Logs share the trace endpoint and headers as well (signal path
    // /v1/logs). Every @sim/logger line fans out through the global Logs API
    // (see packages/logger), which the NodeSDK wires to this processor — the
    // stdout JSON lines continue to CloudWatch unchanged.
    const logRecordProcessor = new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({
        url: normalizeOtlpLogsUrl(telemetryConfig.endpoint),
        headers: otlpHeaders,
        timeoutMillis: Math.min(telemetryConfig.batchSettings.exportTimeoutMillis, 10000),
        keepAlive: false,
      }),
    })

    // Must be unique per process: replicas sharing one instance id collapse
    // into a single Prometheus series, so their independent cumulative
    // counters interleave and corrupt rate()/increase(). The slug keeps Sim
    // distinct from Go for Jaeger's clock-skew grouping; the hostname (the
    // container id under ECS) makes each replica its own series.
    const serviceInstanceId = `${telemetryConfig.serviceName}-${SERVICE_INSTANCE_SLUG}-${hostname()}`
    const resource = defaultResource().merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: telemetryConfig.serviceName,
        [ATTR_SERVICE_VERSION]: telemetryConfig.serviceVersion,
        // OTEL_ → DEPLOYMENT_ENVIRONMENT → APPCONFIG_ENVIRONMENT (mapped to the
        // Go value space) → NODE_ENV. Matches Go's `resourceEnvFromEnv()` so a
        // single $env spans Sim + Go. APPCONFIG_ENVIRONMENT (already set on every
        // deployed tier) is the fix that stops deployed Sim tagging everything
        // "production" via the NODE_ENV fallback — no new infra env var needed.
        [ATTR_DEPLOYMENT_ENVIRONMENT]:
          process.env.OTEL_DEPLOYMENT_ENVIRONMENT ||
          process.env.DEPLOYMENT_ENVIRONMENT ||
          deploymentEnvFromAppConfig(process.env.APPCONFIG_ENVIRONMENT) ||
          env.NODE_ENV ||
          'development',
        'service.namespace': 'mothership',
        'service.instance.id': serviceInstanceId,
        'mothership.origin': MOTHERSHIP_ORIGIN,
        'telemetry.sdk.name': 'opentelemetry',
        'telemetry.sdk.language': 'nodejs',
        'telemetry.sdk.version': '1.0.0',
      })
    )

    const isLocalEndpoint = /localhost|127\.0\.0\.1/i.test(telemetryConfig.endpoint)
    const samplingRatio = resolveSamplingRatio(isLocalEndpoint)
    const rootRatioSampler = new TraceIdRatioBasedSampler(samplingRatio)
    const sampler = createBusinessSpanSampler(rootRatioSampler)

    logger.info('OpenTelemetry sampler configured', {
      samplingRatio,
      endpoint: telemetryConfig.endpoint,
      origin: MOTHERSHIP_ORIGIN,
    })

    // Origin-prefix must run before batch so the rename/attr is captured.
    const spanProcessors: SpanProcessor[] = [new MothershipOriginSpanProcessor(), batchProcessor]

    const sdk = new NodeSDK({
      resource,
      spanProcessors,
      sampler,
      metricReader,
      logRecordProcessors: [logRecordProcessor],
    })

    sdk.start()

    const shutdownOtel = async () => {
      try {
        await sdk.shutdown()
        logger.info('OpenTelemetry SDK shut down successfully')
      } catch (err) {
        logger.error('Error shutting down OpenTelemetry SDK', err)
      }
    }

    process.on('SIGTERM', shutdownOtel)
    process.on('SIGINT', shutdownOtel)

    logger.info('OpenTelemetry instrumentation initialized', {
      serviceName: telemetryConfig.serviceName,
      origin: MOTHERSHIP_ORIGIN,
      samplingRatio,
    })
  } catch (error) {
    logger.error('Failed to initialize OpenTelemetry instrumentation', error)
  }
}

/**
 * Start local scheduler for development environment
 * In production, this is handled by Kubernetes CronJobs
 */
async function startLocalScheduler() {
  // Only run in development and when not in a serverless environment
  if (env.NODE_ENV === 'production' || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return
  }

  try {
    const { Cron } = await import('croner')
    const { env: envConfig } = await import('./lib/core/config/env')

    const cronSecret = envConfig.CRON_SECRET
    if (!cronSecret) {
      logger.warn('CRON_SECRET not configured, local scheduler will not start')
      return
    }

    // Run every minute to check for due schedules
    const cron = new Cron(
      '*/1 * * * *',
      {
        timezone: 'UTC',
        startAt: new Date(Date.now() + 10000), // Start 10 seconds after initialization to ensure app is ready
      },
      async () => {
        try {
          const baseUrl = envConfig.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
          const url = `${baseUrl}/api/schedules/execute`

          // Use built-in fetch (Node.js 18+)
          const response = await fetch(url, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${cronSecret}`,
              'Content-Type': 'application/json',
            },
          })

          if (!response.ok) {
            const contentType = response.headers.get('content-type') ?? ''
            const text = await response.text()
            if (contentType.includes('text/html')) {
              logger.warn(
                `Schedule execution API returned ${response.status} HTML (route likely unavailable — restart the dev server or run dev:clean)`
              )
              return
            }
            logger.warn(`Schedule execution API returned ${response.status}: ${text}`)
          } else {
            const result = (await response.json()) as { executedCount?: number }
            if (result.executedCount && result.executedCount > 0) {
              logger.info(
                `Schedule execution completed: ${result.executedCount} schedules executed`
              )
            } else {
              logger.debug('Schedule execution completed: no schedules due')
            }
          }
        } catch (error) {
          // Don't log fetch errors during startup - app might not be ready yet
          if (error instanceof Error && !error.message.includes('ECONNREFUSED')) {
            logger.error('Error executing scheduled workflows', error)
          }
        }
      }
    )

    logger.info('Local scheduler started (runs every minute)')

    // Cleanup on process exit
    const shutdown = () => {
      cron.stop()
      logger.info('Local scheduler stopped')
    }

    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  } catch (error) {
    logger.error('Failed to start local scheduler', error)
  }
}

export async function register() {
  // Builds the egress policies from EGRESS_ALLOWED_HOSTS and EGRESS_ALLOWED_IP_RANGES so a
  // malformed entry stops the process here, naming the setting, rather than surfacing as a
  // 500 on whichever request first happens to touch an outbound path.
  const { resolveEgressPolicy } = await import('./lib/core/security/egress/profiles')
  resolveEgressPolicy('requestTarget')

  await initializeOpenTelemetry()
  await startLocalScheduler()

  const { getCreditsPerDollarFromMasterConfig } = await import(
    '@/lib/billing/credits/master-config'
  )
  const { setCreditsPerDollar } = await import('@/lib/billing/credits/conversion')
  setCreditsPerDollar(await getCreditsPerDollarFromMasterConfig())

  const shutdownPostHog = async () => {
    try {
      const { getPostHogClient } = await import('@/lib/posthog/server')
      await getPostHogClient()?.shutdown()
      logger.info('PostHog client shut down successfully')
    } catch (err) {
      logger.error('Error shutting down PostHog client', err)
    }
  }

  process.on('SIGTERM', shutdownPostHog)
  process.on('SIGINT', shutdownPostHog)

  const { startMemoryTelemetry } = await import('./lib/monitoring/memory-telemetry')
  startMemoryTelemetry()

  // Not awaited: the connection is warmed in the background so the first request
  // that needs Redis does not pay the handshake inside its own command deadline,
  // but boot never waits on Redis to serve requests that do not touch it.
  const { warmRedisConnection } = await import('@/lib/core/config/redis')
  void warmRedisConnection()

  const { startSimReceivers } = await import('./lib/mothership/transport/receiver')
  await startSimReceivers()

  const { startServiceUsageReplay } = await import('./lib/mothership/billing/service-delivery')
  startServiceUsageReplay()
}
