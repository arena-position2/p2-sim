'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button, Input, InputOTP, InputOTPGroup, InputOTPSlot, Label } from '@sim/emcn'
import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { useRouter } from 'next/navigation'
import { flushSync } from 'react-dom'
import { streamingContentState } from '@/lib/arena-generative-ui/consume-action-sse'
import { resolvePageLanguage } from '@/lib/arena-generative-ui/visual-language'
import { mergePageLoadValues } from '@/lib/arena-generative-ui/form-fields'
import {
  ARENA_GENERATIVE_APP_BASE_PATH,
  actionErrorFrom,
  actionSchemaWarningFrom,
  clearedActionErrorState,
  clearedSelectedIdHostState,
  clearedSelectedItemHostState,
  isJsonRenderSpec,
  navigationHref,
  scrollGenerativeAppToResults,
  scrollGenerativeAppToTop,
  selectedItemHostState,
} from '@/lib/arena-generative-ui/types'
import { SpecRenderer } from '@/app/(interfaces)/gui-apps/[identifier]/spec-renderer'
import { ActionErrorBanner } from '@/app/(interfaces)/gui-apps/action-error-banner'
import { useGenerativeAppHostState } from '@/app/(interfaces)/gui-apps/generative-app-host-state'
import {
  ActionRefreshButton,
  ActionSuccessToast,
  DestructiveConfirmDialog,
} from '@/app/(interfaces)/gui-apps/generative-app-overlays'
import { GenerativeAppThemeRoot } from '@/app/(interfaces)/gui-apps/generative-app-theme-root'
import { SpecRenderErrorBoundary } from '@/app/(interfaces)/gui-apps/spec-render-error-boundary'
import { useGenerativeAppRuntime } from '@/app/(interfaces)/gui-apps/use-generative-app-runtime'
import { usePageLoadActions } from '@/app/(interfaces)/gui-apps/use-page-load-actions'
import {
  runDeployedAppActionStream,
  useDeployedAppConfig,
  useDeployedAppEmailOtpRequest,
  useDeployedAppEmailOtpVerify,
  useDeployedAppPage,
  useDeployedAppPasswordAuth,
  useRunDeployedAppAction,
} from '@/hooks/queries/arena-generative-apps'

const logger = createLogger('GenerativeAppHost')

interface GenerativeAppHostProps {
  identifier: string
  pagePath: string
  emailId: string
  /** Page query params, passed as the input values for the page's `onLoad` actions. */
  pageParams?: Record<string, string>
}

const NO_PAGE_PARAMS: Record<string, string> = {}

export function GenerativeAppHost({
  identifier,
  pagePath,
  emailId,
  pageParams = NO_PAGE_PARAMS,
}: GenerativeAppHostProps) {
  const router = useRouter()
  const configQuery = useDeployedAppConfig(identifier)
  const {
    state,
    mergeState,
    actionPending,
    setActionPending,
    setLoadPending,
    pendingActionIds,
    pageFormValues,
  } = useGenerativeAppHostState()
  const pageQuery = useDeployedAppPage(identifier, pagePath, configQuery.data?.kind === 'config')
  const runAction = useRunDeployedAppAction(identifier)

  const config = configQuery.data?.kind === 'config' ? configQuery.data.config : undefined
  const streamingIds = useMemo(
    () => new Set(config?.streamingActionIds ?? []),
    [config?.streamingActionIds]
  )
  const pageSpec = pageQuery.data?.spec
  const formValues = pageFormValues(pagePath)
  const loadValues = useMemo(
    () =>
      mergePageLoadValues(
        isJsonRenderSpec(pageSpec)
          ? (pageSpec.elements as Record<
              string,
              { type?: string; props?: Record<string, unknown> }
            >)
          : undefined,
        formValues,
        pageParams
      ),
    [pageSpec, formValues, pageParams]
  )

  const executeAction = async (actionId: string, values: Record<string, unknown>) =>
    streamingIds.has(actionId)
      ? await runDeployedAppActionStream({
          identifier,
          actionId,
          values,
          emailId: emailId || undefined,
          onChunk: (accumulated) => {
            mergeState(streamingContentState(accumulated))
          },
        })
      : await runAction.mutateAsync({ actionId, values, emailId: emailId || undefined })

  const navigate = (target: string) => {
    mergeState(clearedActionErrorState())
    router.push(navigationHref(`${ARENA_GENERATIVE_APP_BASE_PATH}/${identifier}`, target, emailId))
  }

  const runtime = useGenerativeAppRuntime({
    runJson: (actionId, values, surface) =>
      runAction.mutateAsync({ actionId, values, emailId: emailId || undefined, surface }),
    runStream: (actionId, values, onChunk, surface) =>
      runDeployedAppActionStream({
        identifier,
        actionId,
        values,
        emailId: emailId || undefined,
        surface,
        onChunk,
      }),
    isStreaming: (actionId) => streamingIds.has(actionId),
    actionNavigate: config?.actionNavigate ?? {},
    actionNavigateWhen: config?.actionNavigateWhen ?? {},
    navigate,
    mergeState,
    setActionPending,
    logger,
    uxPlan: config?.uxPlan,
    actionChatProtocol: config?.actionChatProtocol ?? {},
  })

  const { reload, canRefresh, refreshing } = usePageLoadActions({
    pagePath,
    actionIds: config?.pageOnLoad?.[pagePath] ?? [],
    values: loadValues,
    actionPending,
    runAction: async (actionId, values) => {
      if (!actionPending) runtime.rememberLoad(actionId, values)
      return executeAction(actionId, values)
    },
    mergeState,
    actionHostKeys: config?.actionHostKeys,
    setLoadPending,
  })

  if (configQuery.isLoading) {
    return <p className='p-8 text-(--color-ds-grey-500,#8a8d99) text-sm'>Loading…</p>
  }

  if (configQuery.data?.kind === 'auth') {
    if (configQuery.data.authType === 'password') {
      return <PasswordGate identifier={identifier} />
    }
    if (configQuery.data.authType === 'email') {
      return <EmailGate identifier={identifier} />
    }
    return (
      <div className='flex min-h-[50vh] items-center justify-center p-8 text-center'>
        <div>
          <h1 className='text-2xl'>Sign in required</h1>
          <p className='mt-2 text-(--color-ds-grey-500,#8a8d99)'>
            This app uses SSO. Sign in and reload this page.
          </p>
        </div>
      </div>
    )
  }

  if (configQuery.isError || !configQuery.data || configQuery.data.kind !== 'config') {
    return (
      <div className='p-8 text-center text-(--text-error)'>
        {toError(configQuery.error).message || 'Unable to load this app'}
      </div>
    )
  }

  if (pageQuery.isLoading) {
    return <p className='p-8 text-(--color-ds-grey-500,#8a8d99) text-sm'>Loading page…</p>
  }

  if (!pageQuery.data || !pageSpec || !isJsonRenderSpec(pageSpec)) {
    return <div className='p-8 text-center'>Page not found</div>
  }

  const actionError = actionErrorFrom(state)
  const schemaWarning = actionSchemaWarningFrom(state)
  const bannerMessage = actionError || schemaWarning

  return (
    <GenerativeAppThemeRoot theme={configQuery.data.config.theme}>
      {bannerMessage ? (
        <ActionErrorBanner
          message={bannerMessage}
          tone={actionError ? 'error' : 'warning'}
          onDismiss={runtime.dismissError}
          onRetry={actionError && runtime.canRetry ? runtime.retry : undefined}
        />
      ) : null}
      {canRefresh ? <ActionRefreshButton onRefresh={reload} pending={refreshing} /> : null}
      <SpecRenderErrorBoundary key={pagePath} fallbackTitle='This page failed to render'>
        <div
          data-gui-language={resolvePageLanguage(pageSpec, configQuery.data.config.theme?.language)}
        >
        <SpecRenderer
          spec={pageSpec}
          state={state}
          pending={pendingActionIds.size > 0}
          pendingActionIds={pendingActionIds}
          actionHostKeys={config?.actionHostKeys ?? {}}
          proseAliasKeys={config?.proseAliasKeys ?? []}
          actionHiddenInputs={config?.actionHiddenInputs ?? {}}
          actionChatProtocol={config?.actionChatProtocol ?? {}}
          conversationStorageKey={config?.id ? `deployed:${config.id}` : undefined}
          uxPlan={config?.uxPlan}
          currentPath={pagePath}
          onNavigate={navigate}
          onRunAction={runtime.onRunAction}
          onSelectItem={(item, index) => {
            flushSync(() => {
              mergeState(selectedItemHostState(item, index))
            })
            scrollGenerativeAppToResults({ fallbackToTop: true })
          }}
          onClearItem={() => {
            flushSync(() => {
              mergeState(clearedSelectedItemHostState())
            })
            scrollGenerativeAppToTop()
          }}
          onClearSelection={() => {
            flushSync(() => {
              mergeState(clearedSelectedIdHostState())
            })
          }}
          onCancelPending={runtime.cancelPending}
        />
        </div>
      </SpecRenderErrorBoundary>
      {runtime.toast ? (
        <ActionSuccessToast message={runtime.toast} onDone={runtime.clearToast} />
      ) : null}
      {runtime.confirm ? (
        <DestructiveConfirmDialog
          onCancel={runtime.cancelDestructive}
          onConfirm={runtime.confirmDestructive}
        />
      ) : null}
    </GenerativeAppThemeRoot>
  )
}

function PasswordGate({ identifier }: { identifier: string }) {
  const [password, setPassword] = useState('')
  const authenticate = useDeployedAppPasswordAuth(identifier)
  const [error, setError] = useState<string | null>(null)

  return (
    <form
      className='mx-auto flex min-h-[60vh] max-w-sm flex-col justify-center gap-4 px-4'
      onSubmit={(event) => {
        event.preventDefault()
        setError(null)
        authenticate.mutate({ password }, { onError: (err) => setError(toError(err).message) })
      }}
    >
      <h1 className='text-2xl'>Password required</h1>
      <Label htmlFor='app-password'>Password</Label>
      <Input
        id='app-password'
        type='password'
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      {error ? <p className='text-(--text-error) text-sm'>{error}</p> : null}
      <Button type='submit' disabled={authenticate.isPending}>
        Continue
      </Button>
    </form>
  )
}

function EmailGate({ identifier }: { identifier: string }) {
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestOtp = useDeployedAppEmailOtpRequest(identifier)
  const verifyOtp = useDeployedAppEmailOtpVerify(identifier)

  useEffect(() => {
    if (otp.length === 6) {
      verifyOtp.mutate({ email, otp }, { onError: (err) => setError(toError(err).message) })
    }
  }, [otp, email, verifyOtp])

  return (
    <div className='mx-auto flex min-h-[60vh] max-w-sm flex-col justify-center gap-4 px-4'>
      <h1 className='text-2xl'>Email required</h1>
      <Label htmlFor='app-email'>Email</Label>
      <Input
        id='app-email'
        type='email'
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      {sent ? (
        <>
          <Label>Verification code</Label>
          <InputOTP maxLength={6} value={otp} onChange={setOtp}>
            <InputOTPGroup>
              {Array.from({ length: 6 }).map((_, index) => (
                <InputOTPSlot key={String(index)} index={index} />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </>
      ) : (
        <Button
          type='button'
          disabled={requestOtp.isPending}
          onClick={() => {
            setError(null)
            requestOtp.mutate(
              { email },
              {
                onSuccess: () => setSent(true),
                onError: (err) => setError(toError(err).message),
              }
            )
          }}
        >
          Send code
        </Button>
      )}
      {error ? <p className='text-(--text-error) text-sm'>{error}</p> : null}
    </div>
  )
}
