'use client'

import { useMemo, useState } from 'react'
import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { useRouter } from 'next/navigation'
import { flushSync } from 'react-dom'
import {
  actionChatProtocolFrom,
  actionHiddenInputsFrom,
  actionHostKeysFrom,
  layoutPlansFromBindings,
  proseAliasKeysFromPlans,
} from '@/lib/arena-generative-ui/binding-layout-plan'
import { streamingContentState } from '@/lib/arena-generative-ui/consume-action-sse'
import { resolvePageLanguage } from '@/lib/arena-generative-ui/visual-language'
import { mergePageLoadValues } from '@/lib/arena-generative-ui/form-fields'
import {
  buildPreviewEditInstructions,
  catalogTypesFromManifest,
  overlayFlagsFromManifest,
} from '@/lib/arena-generative-ui/preview-edit-instructions'
import {
  collectRenderDiagnostics,
  pageEditPrompt,
} from '@/lib/arena-generative-ui/render-diagnostics'
import type { ArenaGenerativeTheme } from '@/lib/arena-generative-ui/theme'
import {
  ARENA_GENERATIVE_APP_PREVIEW_BASE_PATH,
  actionErrorFrom,
  actionNavigateFrom,
  actionNavigateWhenFrom,
  actionSchemaWarningFrom,
  clearedActionErrorState,
  clearedSelectedIdHostState,
  clearedSelectedItemHostState,
  isJsonRenderSpec,
  navigationHref,
  scrollGenerativeAppToResults,
  scrollGenerativeAppToTop,
  selectedItemHostState,
  streamingActionIdsFrom,
} from '@/lib/arena-generative-ui/types'
import { compileGenerativeUx } from '@/lib/arena-generative-ui/ux-compiler'
import { applyWaitEstimateFromBrief } from '@/lib/arena-generative-ui/wait-estimate'
import { SpecRenderer } from '@/app/(interfaces)/gui-apps/[identifier]/spec-renderer'
import { ActionErrorBanner } from '@/app/(interfaces)/gui-apps/action-error-banner'
import { useGenerativeAppHostState } from '@/app/(interfaces)/gui-apps/generative-app-host-state'
import {
  ActionRefreshButton,
  ActionSuccessToast,
  DestructiveConfirmDialog,
} from '@/app/(interfaces)/gui-apps/generative-app-overlays'
import { GenerativeAppThemeRoot } from '@/app/(interfaces)/gui-apps/generative-app-theme-root'
import { PreviewAuthorNotes } from '@/app/(interfaces)/gui-apps/preview-author-notes'
import { PreviewThemePicker } from '@/app/(interfaces)/gui-apps/preview-theme-picker'
import { SpecRenderErrorBoundary } from '@/app/(interfaces)/gui-apps/spec-render-error-boundary'
import { useGenerativeAppRuntime } from '@/app/(interfaces)/gui-apps/use-generative-app-runtime'
import { usePageLoadActions } from '@/app/(interfaces)/gui-apps/use-page-load-actions'
import {
  runGenerativeAppDraftActionStream,
  useGenerativeAppDraft,
  useRunGenerativeAppDraftAction,
} from '@/hooks/queries/arena-generative-apps'

const logger = createLogger('GenerativeAppPreviewHost')

interface GenerativeAppPreviewHostProps {
  draftId: string
  pagePath: string
  /** Page query params, passed as the input values for the page's `onLoad` actions. */
  pageParams?: Record<string, string>
}

const NO_PAGE_PARAMS: Record<string, string> = {}

export function GenerativeAppPreviewHost({
  draftId,
  pagePath,
  pageParams = NO_PAGE_PARAMS,
}: GenerativeAppPreviewHostProps) {
  const router = useRouter()
  const draftQuery = useGenerativeAppDraft(draftId)
  const runAction = useRunGenerativeAppDraftAction(draftId)
  const {
    state,
    mergeState,
    actionPending,
    setActionPending,
    setLoadPending,
    pendingActionIds,
    pageFormValues,
  } = useGenerativeAppHostState()
  const [throwByKey, setThrowByKey] = useState<Record<string, string>>({})
  const [themeOverride, setThemeOverride] = useState<ArenaGenerativeTheme | undefined>(undefined)
  const [copiedPagePrompt, setCopiedPagePrompt] = useState(false)

  const manifest = draftQuery.data?.manifest
  const apiBindings = draftQuery.data?.apiBindings
  const brief = draftQuery.data?.brief ?? ''
  const streamingIds = useMemo(
    () => new Set(manifest && apiBindings ? streamingActionIdsFrom(manifest, apiBindings) : []),
    [manifest, apiBindings]
  )
  const compiled = useMemo(() => {
    if (!manifest) return undefined
    const stamped = applyWaitEstimateFromBrief(manifest, brief)
    return compileGenerativeUx(stamped.manifest, apiBindings ?? [])
  }, [manifest, apiBindings, brief])
  const compiledPages = compiled?.pages
  const uxPlan = compiled?.uxPlan

  const actionNavigate = manifest ? actionNavigateFrom(manifest) : {}
  const actionNavigateWhen = manifest ? actionNavigateWhenFrom(manifest) : {}
  const actionHostKeys = manifest ? actionHostKeysFrom(manifest, apiBindings ?? []) : {}
  const proseAliasKeys = manifest
    ? proseAliasKeysFromPlans(layoutPlansFromBindings(apiBindings ?? []))
    : []
  const actionHiddenInputs = manifest ? actionHiddenInputsFrom(manifest, apiBindings ?? []) : {}
  const actionChatProtocol = manifest ? actionChatProtocolFrom(manifest, apiBindings ?? []) : {}

  const executeAction = async (actionId: string, values: Record<string, unknown>) =>
    streamingIds.has(actionId)
      ? await runGenerativeAppDraftActionStream({
          draftId,
          actionId,
          values,
          onChunk: (accumulated) => {
            mergeState(streamingContentState(accumulated))
          },
        })
      : await runAction.mutateAsync({ actionId, values })

  const navigate = (target: string) => {
    mergeState(clearedActionErrorState())
    router.push(navigationHref(`${ARENA_GENERATIVE_APP_PREVIEW_BASE_PATH}/${draftId}`, target))
  }

  const runtime = useGenerativeAppRuntime({
    runJson: (actionId, values, surface) => runAction.mutateAsync({ actionId, values, surface }),
    runStream: (actionId, values, onChunk, surface) =>
      runGenerativeAppDraftActionStream({
        draftId,
        actionId,
        values,
        surface,
        onChunk,
      }),
    isStreaming: (actionId) => streamingIds.has(actionId),
    actionNavigate,
    actionNavigateWhen,
    navigate,
    mergeState,
    setActionPending,
    logger,
    uxPlan,
    actionChatProtocol,
  })

  const pageSpec = manifest?.pages[pagePath]?.spec
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

  const { reload, canRefresh, refreshing } = usePageLoadActions({
    pagePath,
    actionIds: manifest?.pages[pagePath]?.onLoad ?? [],
    values: loadValues,
    actionPending,
    runAction: async (actionId, values) => {
      if (!actionPending) runtime.rememberLoad(actionId, values)
      return executeAction(actionId, values)
    },
    mergeState,
    actionHostKeys,
    setLoadPending,
  })

  if (draftQuery.isLoading) {
    return <p className='p-8 text-(--color-ds-grey-500,#8a8d99) text-sm'>Loading…</p>
  }

  if (draftQuery.isError || !draftQuery.data || !manifest) {
    return (
      <div className='p-8 text-center text-(--text-error)'>
        {toError(draftQuery.error).message || 'Unable to load this draft'}
      </div>
    )
  }

  if (draftQuery.data.planStatus === 'planned') {
    return (
      <div className='p-8 text-center text-(--text-secondary) text-sm'>
        This draft is a product contract only. Confirm the plan in the Arena Generative UI block,
        then run Generate from Plan before Preview.
      </div>
    )
  }

  const page = manifest.pages[pagePath]
  if (!page || !isJsonRenderSpec(page.spec)) {
    return <div className='p-8 text-center'>Page not found</div>
  }

  const actionError = actionErrorFrom(state)
  const schemaWarning = actionSchemaWarningFrom(state)
  const bannerMessage = actionError || schemaWarning
  const pending = pendingActionIds.size > 0
  const renderKey = `${pagePath}:${draftQuery.data.revision}`
  const throwMessage = throwByKey[renderKey]
  const diagnostics = [
    ...collectRenderDiagnostics(page.spec, state, pending),
    ...(throwMessage
      ? [{ kind: 'throw' as const, message: `SpecRenderer threw: ${throwMessage}` }]
      : []),
  ]
  const editInstructions = buildPreviewEditInstructions({
    pagePath,
    diagnostics,
    generateWarnings: draftQuery.data.generateWarnings ?? [],
    adoptedChanges: draftQuery.data.adoptedChanges ?? [],
    screenshotGaps: draftQuery.data.screenshotGaps ?? [],
    capabilities: draftQuery.data.capabilities ?? [],
    appCatalogTypes: catalogTypesFromManifest(manifest),
    overlayFlags: overlayFlagsFromManifest(manifest),
    apiBindingKeys: (apiBindings ?? []).map((binding) => binding.key),
    outputHostKeys: layoutPlansFromBindings(apiBindings ?? []).flatMap((plan) => plan.hostKeys),
  })
  const liveTheme = themeOverride ?? manifest.theme
  const pagePrompt = pageEditPrompt(pagePath)

  return (
    <GenerativeAppThemeRoot theme={liveTheme}>
      <div className='min-h-screen'>
        <div className='flex flex-wrap items-center justify-between gap-2 border-(--gui-border,#e2e3e5) border-b bg-(--gui-canvas,#f7f8f9) px-4 py-2 text-(--gui-text-muted,#8a8d99) text-xs'>
          <span>Preview — not published. CTAs run against this draft.</span>
          <div className='flex flex-wrap items-center gap-3'>
            <PreviewAuthorNotes
              generateWarnings={draftQuery.data.generateWarnings ?? []}
              adoptedChanges={draftQuery.data.adoptedChanges ?? []}
              screenshotMatchNotes={draftQuery.data.screenshotMatchNotes}
              editInstructions={editInstructions}
            />
            <button
              type='button'
              data-testid='copy-page-edit-prompt'
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(pagePrompt)
                  setCopiedPagePrompt(true)
                } catch {
                  setCopiedPagePrompt(false)
                }
              }}
              className='text-(--gui-brand,#1a73e8) hover:underline'
            >
              {copiedPagePrompt ? 'Copied' : 'Copy page edit prompt'}
            </button>
          </div>
        </div>
        <PreviewThemePicker theme={liveTheme} onChange={setThemeOverride} />
        {bannerMessage ? (
          <ActionErrorBanner
            message={bannerMessage}
            tone={actionError ? 'error' : 'warning'}
            onDismiss={runtime.dismissError}
            onRetry={actionError && runtime.canRetry ? runtime.retry : undefined}
          />
        ) : null}
        {canRefresh ? <ActionRefreshButton onRefresh={reload} pending={refreshing} /> : null}
        <SpecRenderErrorBoundary
          key={renderKey}
          fallbackTitle='This page failed to render'
          onError={(message) => {
            setThrowByKey((current) => ({ ...current, [renderKey]: message }))
          }}
        >
          <div
            data-gui-language={resolvePageLanguage(
              compiledPages?.[pagePath]?.spec ?? page.spec,
              liveTheme?.language
            )}
          >
          <SpecRenderer
            spec={compiledPages?.[pagePath]?.spec ?? page.spec}
            state={state}
            pending={pending}
            pendingActionIds={pendingActionIds}
            actionHostKeys={actionHostKeys}
            proseAliasKeys={proseAliasKeys}
            actionHiddenInputs={actionHiddenInputs}
            actionChatProtocol={actionChatProtocol}
            conversationStorageKey={`preview:${draftId}`}
            uxPlan={uxPlan}
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
      </div>
    </GenerativeAppThemeRoot>
  )
}
