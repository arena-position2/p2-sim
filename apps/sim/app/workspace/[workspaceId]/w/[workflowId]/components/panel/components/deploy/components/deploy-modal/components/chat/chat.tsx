'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChipConfirmModal,
  ChipEmailsInput,
  ChipInput,
  ChipSelect,
  Label,
  Skeleton,
  Switch,
  Textarea,
} from '@sim/emcn'
import { TriangleAlert } from '@sim/emcn/icons'
import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { GeneratedPasswordInput } from '@/components/ui'
import { useSession } from '@/lib/auth/auth-client'
import { buildChatDeploymentUrl } from '@/lib/chat-deployments/urls'
import { useDeploymentShape } from '@/lib/core/config/deployment-shape'
import { validateAllowlistEntry } from '@/lib/messaging/email/validation'
import { formatInternalOutputSelector } from '@/lib/workflows/streaming/output-selector'
import { OutputSelect } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/chat/components/output-select/output-select'
import {
  type AuthType,
  type ChatFormData,
  useAgentDepartments,
  useCreateChat,
  useDeleteChat,
  useRevealChatPassword,
  useUpdateChat,
} from '@/hooks/queries/chats'
import type { ChatDetail } from '@/hooks/queries/deployments'
import { usePermissionConfig } from '@/hooks/use-permission-config'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'
import {
  getPasswordHelperText,
  getPasswordPlaceholder,
  hasExistingPassword,
  isPasswordRequired,
  isWhitespaceOnlyPassword,
  shouldConfirmPasswordChange,
} from './utils'

const logger = createLogger('ChatDeploy')

function dedupeStrings(values: readonly string[]): string[] {
  const seen: Record<string, true> = {}
  const result: string[] = []
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (!seen[value]) {
      seen[value] = true
      result.push(value)
    }
  }
  return result
}

interface ChatDeployProps {
  workflowId: string
  workflowWorkspaceId?: string
  existingChat: ExistingChat | null
  isLoadingChat: boolean
  onRefetchChat: () => Promise<void>
  chatSubmitting: boolean
  setChatSubmitting: (submitting: boolean) => void
  canRevealPassword: boolean
  onValidationChange?: (isValid: boolean) => void
  showDeleteConfirmation?: boolean
  setShowDeleteConfirmation?: (show: boolean) => void
  onDeploymentComplete?: () => void
  onDeployed?: () => void
  onVersionActivated?: () => void
  chatAlreadyExists?: boolean | any
  /** Chat tab vs App tab — controls which fields are shown and which deploymentType is saved */
  mode?: 'chat' | 'app'
}

export type ExistingChat = ChatDetail

function isMatchingDeployment(
  existingChat: ExistingChat | null | undefined,
  mode: 'chat' | 'app'
): existingChat is ExistingChat {
  return Boolean(existingChat && (existingChat.deploymentType ?? 'chat') === mode)
}

interface FormErrors {
  identifier?: string
  title?: string
  department?: string
  description?: string
  password?: string
  emails?: string
  outputBlocks?: string
  redirectUrl?: string
  general?: string
}

function isValidRedirectUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function normalizeSessionEmail(email: string | null | undefined): string | null {
  const normalized = email?.toLowerCase().trim()
  if (!normalized || validateAllowlistEntry(normalized)) return null
  return normalized
}

function createInitialFormData(mode: 'chat' | 'app', sessionEmail?: string | null): ChatFormData {
  const email = normalizeSessionEmail(sessionEmail)
  return {
    identifier: '',
    title: '',
    description: '',
    department: '',
    authType: 'email',
    password: '',
    emails: email ? [email] : [],
    welcomeMessage:
      "How can I help you today? I'm here to answer your questions and assist you with anything you need.",
    goldenQueries: [],
    selectedOutputBlocks: [],
    deploymentType: mode,
    redirectUrl: '',
    includeThinking: false,
    includeToolCalls: false,
  }
}

export function ChatDeploy({
  workflowId,
  workflowWorkspaceId,
  existingChat,
  isLoadingChat,
  onRefetchChat,
  chatSubmitting,
  setChatSubmitting,
  canRevealPassword,
  onValidationChange,
  showDeleteConfirmation: externalShowDeleteConfirmation,
  setShowDeleteConfirmation: externalSetShowDeleteConfirmation,
  onDeploymentComplete,
  onDeployed,
  onVersionActivated,
  mode = 'chat',
}: ChatDeployProps) {
  const isAppMode = mode === 'app'
  const formId = isAppMode ? 'app-deploy-form' : 'chat-deploy-form'
  const { data: session } = useSession()
  const sessionEmail = normalizeSessionEmail(session?.user?.email)
  const initialFormData = createInitialFormData(mode, sessionEmail)
  const { data: departmentsData } = useAgentDepartments()
  const departmentOptions = useMemo(
    () =>
      (departmentsData?.departments ?? []).map((department) => ({
        value: department.value,
        label: department.label,
      })),
    [departmentsData?.departments]
  )

  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [internalShowDeleteConfirmation, setInternalShowDeleteConfirmation] = useState(false)
  const [showPasswordChangeConfirmation, setShowPasswordChangeConfirmation] = useState(false)

  const showDeleteConfirmation =
    externalShowDeleteConfirmation !== undefined
      ? externalShowDeleteConfirmation
      : internalShowDeleteConfirmation

  const setShowDeleteConfirmation =
    externalSetShowDeleteConfirmation || setInternalShowDeleteConfirmation

  const [formData, setFormData] = useState<ChatFormData>(initialFormData)
  const [errors, setErrors] = useState<FormErrors>({})
  const formRef = useRef<HTMLFormElement>(null)
  const hasSetDefaultKnowledgeOutputs = useRef(false)

  const blocks = useWorkflowStore((state) => state.blocks)
  const knowledgeResultOutputIds = useMemo(() => {
    return Object.values(blocks)
      .filter((block: { type?: string }) => block?.type === 'knowledge')
      .map((block: { id: string }) => `${block.id}_results`)
  }, [blocks])

  const [showUnselectKnowledgeConfirm, setShowUnselectKnowledgeConfirm] = useState(false)
  const [pendingOutputSelection, setPendingOutputSelection] = useState<string[] | null>(null)
  const [formInitCounter, setFormInitCounter] = useState(0)

  const createChatMutation = useCreateChat()
  const updateChatMutation = useUpdateChat()
  const deleteChatMutation = useDeleteChat()
  const [isIdentifierValid, setIsIdentifierValid] = useState(false)
  const hasInitializedFormRef = useRef(false)
  const existingPassword = hasExistingPassword(existingChat)

  /** When switching workflows, clear form + init flags so we never show the previous workflow's chat/API-derived fields. */
  const prevWorkflowIdForFormRef = useRef<string | null>(null)
  useEffect(() => {
    if (
      prevWorkflowIdForFormRef.current !== null &&
      prevWorkflowIdForFormRef.current !== workflowId
    ) {
      setFormData({
        ...createInitialFormData(mode, sessionEmail),
        identifier: workflowId || '',
      })
      setImageUrl(null)
      hasInitializedFormRef.current = false
      hasSetDefaultKnowledgeOutputs.current = false
      setErrors({})
      setFormInitCounter((c) => c + 1)
    }
    prevWorkflowIdForFormRef.current = workflowId
  }, [workflowId, mode, sessionEmail])

  const updateField = <K extends keyof ChatFormData>(field: K, value: ChatFormData[K]) => {
    setFormData((prev) => ({
      ...prev,
      identifier: workflowId,
      deploymentType: mode,
      [field]: value,
    }))
    if (errors[field as keyof FormErrors]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }))
    }
  }

  const setError = (field: keyof FormErrors, message: string) => {
    setErrors((prev) => ({ ...prev, [field]: message }))
  }

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {}

    if (!formData.title.trim()) {
      newErrors.title = 'Title is required'
    }

    if (!formData.description.trim()) {
      newErrors.description = 'Description is required'
    }

    if (isPasswordRequired(formData.authType, formData.password, existingPassword)) {
      newErrors.password = 'Password is required when using password protection'
    } else if (formData.authType === 'password' && isWhitespaceOnlyPassword(formData.password)) {
      newErrors.password = 'Password cannot contain only whitespace'
    }

    if (
      (formData.authType === 'email' || formData.authType === 'sso') &&
      formData.emails.length === 0
    ) {
      newErrors.emails = `At least one email or domain is required when using ${formData.authType === 'sso' ? 'SSO' : 'email'} access control`
    }

    if (!isAppMode && formData.selectedOutputBlocks.length === 0) {
      newErrors.outputBlocks = 'Please select at least one output block'
    }

    if (isAppMode) {
      if (!formData.redirectUrl.trim()) {
        newErrors.redirectUrl = 'Redirection URL is required when deploying as an app'
      } else if (!isValidRedirectUrl(formData.redirectUrl.trim())) {
        newErrors.redirectUrl = 'Enter a valid URL starting with http:// or https://'
      }
    }

    if (!formData.department?.trim()) {
      newErrors.department = 'Category is required'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const isFormValid =
    isIdentifierValid &&
    Boolean(formData.title.trim()) &&
    Boolean(formData.department?.trim()) &&
    (isAppMode || formData.selectedOutputBlocks.length > 0) &&
    (formData.authType !== 'password' || !isWhitespaceOnlyPassword(formData.password)) &&
    ((formData.authType !== 'email' && formData.authType !== 'sso') ||
      formData.emails.length > 0) &&
    (!isAppMode || isValidRedirectUrl(formData.redirectUrl.trim()))

  useEffect(() => {
    onValidationChange?.(isFormValid)
  }, [isFormValid, onValidationChange])

  useEffect(() => {
    if (workflowId) {
      setIsIdentifierValid(true)
    }
  }, [workflowId])

  useEffect(() => {
    if (isMatchingDeployment(existingChat, mode) && !hasInitializedFormRef.current) {
      const allowedEmails = Array.isArray(existingChat.allowedEmails)
        ? existingChat.allowedEmails
        : []
      const normalizedEmails = allowedEmails.map((e) => e.toLowerCase().trim())
      const uniqueEmails = dedupeStrings(normalizedEmails)
      setFormData({
        identifier: existingChat.identifier || workflowId || '',
        title: existingChat.title || '',
        description: existingChat.description || '',
        department: existingChat.department || '',
        authType: existingChat.authType || 'public',
        password: '',
        emails: uniqueEmails,
        welcomeMessage:
          existingChat.customizations?.welcomeMessage !== undefined &&
          existingChat.customizations?.welcomeMessage !== null
            ? existingChat.customizations.welcomeMessage
            : "How can I help you today? I'm here to answer your questions and assist you with anything you need.",
        goldenQueries: existingChat.customizations?.goldenQueries ?? [],
        selectedOutputBlocks: Array.isArray(existingChat.outputConfigs)
          ? existingChat.outputConfigs.map(
              (config: { workflowId?: string; blockId: string; path: string }) =>
                formatInternalOutputSelector(config.blockId, config.path, config.workflowId)
            )
          : [],
        deploymentType: mode,
        redirectUrl: isAppMode ? existingChat.redirectUrl || '' : '',
        includeThinking: existingChat.includeThinking ?? false,
        includeToolCalls: existingChat.includeToolCalls ?? false,
      })

      if (existingChat.customizations?.imageUrl) {
        setImageUrl(existingChat.customizations.imageUrl)
      }

      hasInitializedFormRef.current = true
    } else if (
      !isMatchingDeployment(existingChat, mode) &&
      !isLoadingChat &&
      !hasInitializedFormRef.current
    ) {
      setFormData(createInitialFormData(mode, sessionEmail))
      setImageUrl(null)
      hasInitializedFormRef.current = true
      hasSetDefaultKnowledgeOutputs.current = false
      setFormInitCounter((c) => c + 1)
    }
  }, [existingChat, isLoadingChat, mode, isAppMode, workflowId, sessionEmail])

  /**
   * Ensure the signed-in user is always on the allowlist for new email/SSO
   * deployments — even if the session resolved after the form first mounted.
   */
  useEffect(() => {
    if (existingChat || isLoadingChat || !sessionEmail) return
    if (formData.authType !== 'email' && formData.authType !== 'sso') return

    setFormData((prev) => {
      if (prev.emails.includes(sessionEmail)) return prev
      return { ...prev, emails: [sessionEmail, ...prev.emails] }
    })
  }, [existingChat, isLoadingChat, sessionEmail, formData.authType])

  useEffect(() => {
    if (
      !isAppMode &&
      !existingChat &&
      !isLoadingChat &&
      workflowId &&
      knowledgeResultOutputIds.length > 0 &&
      !hasSetDefaultKnowledgeOutputs.current
    ) {
      hasSetDefaultKnowledgeOutputs.current = true
      setFormData((prev) => ({
        ...prev,
        selectedOutputBlocks: [
          ...new Set([...prev.selectedOutputBlocks, ...knowledgeResultOutputIds]),
        ],
      }))
    }
  }, [existingChat, isLoadingChat, workflowId, knowledgeResultOutputIds, isAppMode])

  const handleConfirmUnselectKnowledge = useCallback(() => {
    if (pendingOutputSelection !== null) {
      updateField('selectedOutputBlocks', pendingOutputSelection)
      setPendingOutputSelection(null)
    }
    setShowUnselectKnowledgeConfirm(false)
  }, [pendingOutputSelection, updateField])

  const handleCancelUnselectKnowledge = useCallback(() => {
    setPendingOutputSelection(null)
    setShowUnselectKnowledgeConfirm(false)
  }, [])

  const submitChat = async (passwordChangeConfirmed = false) => {
    if (chatSubmitting) return

    setChatSubmitting(true)

    const isNewChat = !isMatchingDeployment(existingChat, mode)

    try {
      if (!validateForm()) {
        setChatSubmitting(false)
        return
      }

      if (!isIdentifierValid && formData.identifier !== existingChat?.identifier) {
        setError('identifier', 'Please wait for identifier validation to complete')
        return
      }

      if (
        !passwordChangeConfirmed &&
        shouldConfirmPasswordChange(existingPassword, formData.authType, formData.password)
      ) {
        setShowPasswordChangeConfirmation(true)
        return
      }

      let chatUrl: string
      const submitFormData: ChatFormData = {
        ...formData,
        deploymentType: mode,
        redirectUrl: isAppMode ? formData.redirectUrl : '',
        selectedOutputBlocks: isAppMode ? [] : formData.selectedOutputBlocks,
      }

      if (isMatchingDeployment(existingChat, mode)) {
        const result = await updateChatMutation.mutateAsync({
          chatId: existingChat.id,
          workflowId,
          formData: submitFormData,
          imageUrl,
        })
        chatUrl = result.chatUrl
      } else {
        const result = await createChatMutation.mutateAsync({
          workflowId,
          formData: submitFormData,
          imageUrl,
        })
        chatUrl = result.chatUrl
      }

      onDeployed?.()
      onVersionActivated?.()

      if (isNewChat) {
        if (isAppMode && submitFormData.redirectUrl.trim()) {
          window.open(submitFormData.redirectUrl.trim(), '_blank', 'noopener,noreferrer')
        } else if (chatUrl) {
          const url = `${chatUrl}?workspaceId=${workflowWorkspaceId}&fromControlBar=true`
          window.open(url, '_blank', 'noopener,noreferrer')
        }
      }

      hasInitializedFormRef.current = false
      await onRefetchChat()
      setFormInitCounter((c) => c + 1)
    } catch (error: unknown) {
      const message = getErrorMessage(error)
      if (message.includes('identifier')) {
        setError('identifier', message)
      } else {
        setError('general', message)
      }
    } finally {
      setChatSubmitting(false)
    }
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    await submitChat()
  }

  const handleDelete = async () => {
    if (!existingChat || !existingChat.id) return

    try {
      await deleteChatMutation.mutateAsync({
        chatId: existingChat.id,
        workflowId,
      })

      setImageUrl(null)
      hasInitializedFormRef.current = false
      setFormInitCounter((c) => c + 1)
      await onRefetchChat()

      onDeploymentComplete?.()
    } catch (error: unknown) {
      logger.error('Failed to delete chat:', error)
      setError('general', getErrorMessage(error) || 'An unexpected error occurred while deleting')
    } finally {
      setShowDeleteConfirmation(false)
    }
  }

  const handleConfirmPasswordChange = async () => {
    setShowPasswordChangeConfirmation(false)
    await submitChat(true)
  }

  if (isLoadingChat) {
    return <LoadingSkeleton />
  }

  return (
    <>
      <form id={formId} ref={formRef} onSubmit={handleSubmit} className='-mx-1 space-y-4 px-1'>
        {errors.general && (
          <div className='flex items-center gap-2 rounded-md border border-[color-mix(in_srgb,var(--text-error)_20%,transparent)] bg-[color-mix(in_srgb,var(--text-error)_10%,transparent)] px-3 py-2 text-[var(--text-error)] text-small'>
            <TriangleAlert className='size-4 shrink-0' />
            <span>{errors.general}</span>
          </div>
        )}

        <div>
          <Label
            htmlFor={`${formId}-title`}
            className='mb-[6.5px] block pl-0.5 text-[var(--text-primary)] text-small'
          >
            Title
          </Label>
          <ChipInput
            id={`${formId}-title`}
            placeholder='Customer Support Assistant'
            value={formData.title}
            onChange={(e) => updateField('title', e.target.value)}
            required
            disabled={chatSubmitting}
          />
          {errors.title && <p className='mt-1 text-destructive text-sm'>{errors.title}</p>}
        </div>

        <div className='space-y-[12px]'>
          <div>
            <Label className='mb-[6.5px] block pl-0.5 text-[var(--text-primary)] text-small'>
              Category
            </Label>
            <ChipSelect
              aria-label='Category'
              aria-required
              aria-invalid={Boolean(errors.department)}
              aria-describedby={errors.department ? `${formId}-department-error` : undefined}
              align='start'
              fullWidth
              dropdownWidth='trigger'
              stayBelow
              value={formData.department || ''}
              onChange={(value) => updateField('department', value)}
              disabled={chatSubmitting}
              placeholder='Select category'
              options={departmentOptions}
            />
            {errors.department && (
              <p id={`${formId}-department-error`} className='mt-1 text-destructive text-sm'>
                {errors.department}
              </p>
            )}
          </div>
          <div>
            <Label className='mb-[6.5px] block pl-0.5 text-[var(--text-primary)] text-small'>
              Description
            </Label>
            <Textarea
              id={`${formId}-description`}
              placeholder={
                isAppMode
                  ? 'A brief description of what this app does'
                  : 'A brief description of what this chat does'
              }
              value={formData.description}
              onChange={(e) => updateField('description', e.target.value)}
              rows={3}
              disabled={chatSubmitting}
              className='min-h-[80px] resize-none'
            />
            {errors.description && (
              <p className='mt-1 text-destructive text-sm'>{errors.description}</p>
            )}
          </div>

          {isAppMode ? (
            <div>
              <Label
                htmlFor={`${formId}-redirectUrl`}
                className='mb-[6.5px] block pl-0.5 text-[var(--text-primary)] text-small'
              >
                Redirection URL
              </Label>
              <ChipInput
                id={`${formId}-redirectUrl`}
                placeholder='https://company-research-agent-app.vercel.app/'
                value={formData.redirectUrl}
                onChange={(e) => updateField('redirectUrl', e.target.value)}
                required
                disabled={chatSubmitting}
              />
              {errors.redirectUrl && (
                <p className='mt-1 text-destructive text-sm'>{errors.redirectUrl}</p>
              )}
            </div>
          ) : (
            <div>
              <Label className='mb-[6.5px] block pl-0.5 text-[var(--text-primary)] text-small'>
                Output
              </Label>
              <OutputSelect
                workflowId={workflowId}
                selectedOutputs={formData.selectedOutputBlocks}
                onOutputSelect={(values) => updateField('selectedOutputBlocks', values)}
                placeholder='Select which block outputs to use'
                disabled={chatSubmitting}
                size='md'
                variant='chip'
                className='w-full'
                disablePortal
              />
              {errors.outputBlocks && (
                <p className='mt-[6.5px] text-[var(--text-error)] text-caption'>
                  {errors.outputBlocks}
                </p>
              )}
            </div>
          )}

          <div className='flex items-center justify-between gap-3'>
            <div className='min-w-0'>
              <Label className='block pl-0.5 text-small'>Include thinking</Label>
            </div>
            <Switch
              checked={formData.includeThinking}
              disabled={chatSubmitting}
              onCheckedChange={(checked) => updateField('includeThinking', checked)}
              aria-label='Include thinking'
            />
          </div>

          <div className='flex items-center justify-between gap-3'>
            <div className='min-w-0'>
              <Label className='block pl-0.5 text-small'>Include tool calls</Label>
            </div>
            <Switch
              checked={formData.includeToolCalls}
              disabled={chatSubmitting}
              onCheckedChange={(checked) => updateField('includeToolCalls', checked)}
              aria-label='Include tool calls'
            />
          </div>

          <AuthSelector
            isExistingChat={!!existingChat}
            key={`${existingChat?.id ?? 'new'}-${formInitCounter}`}
            chatId={existingChat?.id ?? null}
            canRevealPassword={canRevealPassword}
            authType={formData.authType}
            savedAuthType={existingChat?.authType as AuthType | undefined}
            password={formData.password}
            emails={formData.emails}
            onAuthTypeChange={(type) => updateField('authType', type)}
            onPasswordChange={(password) => updateField('password', password)}
            onEmailsChange={(emails) => updateField('emails', emails)}
            disabled={chatSubmitting}
            hasExistingPassword={existingPassword}
            error={errors.password || errors.emails}
          />
          <div>
            <Label
              htmlFor={`${formId}-welcomeMessage`}
              className='mb-[6.5px] block pl-0.5 text-[var(--text-primary)] text-small'
            >
              Welcome message
            </Label>
            <Textarea
              id={`${formId}-welcomeMessage`}
              placeholder='Enter a welcome message for your chat'
              value={formData.welcomeMessage}
              onChange={(e) => updateField('welcomeMessage', e.target.value)}
              rows={3}
              disabled={chatSubmitting}
              className='min-h-[80px] resize-none'
            />
            <p className='mt-[6.5px] text-[var(--text-secondary)] text-xs'>
              This message will be displayed when users first open the chat
            </p>
          </div>

          <button
            type='button'
            data-delete-trigger
            onClick={() => setShowDeleteConfirmation(true)}
            className='hidden'
          />
        </div>
      </form>

      <ChipConfirmModal
        open={showPasswordChangeConfirmation}
        onOpenChange={setShowPasswordChangeConfirmation}
        srTitle='Change deployment password'
        title='Change deployment password?'
        text='Are you sure you want to change the password for this deployment?'
        confirm={{
          label: 'Change Password and Redeploy',
          onClick: handleConfirmPasswordChange,
          variant: 'primary',
          pending: chatSubmitting,
          pendingLabel: 'Updating...',
        }}
      />

      <ChipConfirmModal
        open={showDeleteConfirmation}
        onOpenChange={setShowDeleteConfirmation}
        srTitle={isAppMode ? 'Delete App' : 'Delete Chat'}
        title={isAppMode ? 'Delete App' : 'Delete Chat'}
        text={[
          'Are you sure you want to delete ',
          { text: existingChat?.title || (isAppMode ? 'this app' : 'this chat'), bold: true },
          '? ',
          {
            text: isAppMode
              ? 'This will remove the app deployment and make it unavailable to all users.'
              : `This will remove the chat at "${buildChatDeploymentUrl(existingChat?.identifier ?? '').replace(/^https?:\/\//, '')}" and make it unavailable to all users.`,
            error: true,
          },
          ' This action cannot be undone.',
        ]}
        confirm={{
          label: 'Delete',
          onClick: handleDelete,
          pending: deleteChatMutation.isPending,
          pendingLabel: 'Deleting...',
        }}
      />
      <ChipConfirmModal
        open={showUnselectKnowledgeConfirm}
        onOpenChange={(open) => {
          if (!open) handleCancelUnselectKnowledge()
        }}
        srTitle='Unselect knowledge base results'
        title='Unselect knowledge base results'
        confirm={{
          label: 'Continue',
          variant: 'primary',
          onClick: handleConfirmUnselectKnowledge,
        }}
      />
    </>
  )
}

function LoadingSkeleton() {
  return (
    <div className='-mx-1 space-y-4 px-1'>
      <div className='space-y-3'>
        <div>
          <Skeleton className='mb-[6.5px] h-[16px] w-[26px]' />
          <Skeleton className='h-[34px] w-full rounded-sm' />
          <Skeleton className='mt-[6.5px] h-[14px] w-[320px]' />
        </div>
        <div>
          <Skeleton className='mb-[6.5px] h-[16px] w-[30px]' />
          <Skeleton className='h-[34px] w-full rounded-sm' />
        </div>
        <div>
          <Skeleton className='mb-[6.5px] h-[16px] w-[46px]' />
          <Skeleton className='h-[34px] w-full rounded-sm' />
        </div>
        <div>
          <Skeleton className='mb-[6.5px] h-[16px] w-[95px]' />
          <Skeleton className='h-[28px] w-[170px] rounded-sm' />
        </div>
        <div>
          <Skeleton className='mb-[6.5px] h-[16px] w-[115px]' />
          <Skeleton className='h-[80px] w-full rounded-sm' />
          <Skeleton className='mt-[6.5px] h-[14px] w-[340px]' />
        </div>
      </div>
    </div>
  )
}

interface AuthSelectorProps {
  chatId: string | null
  canRevealPassword: boolean
  authType: AuthType
  /** The persisted mode of an existing chat, kept selectable even if newly disallowed. */
  savedAuthType?: AuthType
  password: string
  emails: string[]
  onAuthTypeChange: (type: AuthType) => void
  onPasswordChange: (password: string) => void
  onEmailsChange: (emails: string[]) => void
  disabled?: boolean
  hasExistingPassword?: boolean
  error?: string
  /** When false (create mode), prefill the signed-in user's email once. */
  isExistingChat?: boolean
}

function AuthSelector({
  chatId,
  canRevealPassword,
  authType,
  savedAuthType,
  password,
  emails,
  onAuthTypeChange,
  onPasswordChange,
  onEmailsChange,
  disabled = false,
  hasExistingPassword = false,
  error,
  isExistingChat = false,
}: AuthSelectorProps) {
  const { data: session } = useSession()
  const hasPrefilledSessionEmailRef = useRef(false)
  const revealPasswordMutation = useRevealChatPassword()
  const { features } = useDeploymentShape()

  /**
   * Editing or regenerating the password clears a failed reveal. The mutation
   * only drops its error on the next attempt, so it would otherwise keep
   * reporting a stale failure over a field the admin has already moved on from.
   */
  const handlePasswordChange = (value: string) => {
    if (revealPasswordMutation.isError) revealPasswordMutation.reset()
    onPasswordChange(value)
  }

  const { config: permissionConfig } = usePermissionConfig()
  const allowedAuthTypes = permissionConfig.allowedChatDeployAuthTypes

  const ssoAvailable =
    features.sso || savedAuthType === 'sso' || (allowedAuthTypes?.includes('sso') ?? false)
  const baseAuthOptions: AuthType[] = ssoAvailable
    ? ['public', 'password', 'email', 'sso']
    : ['public', 'password', 'email']

  const authOptions = baseAuthOptions.filter(
    (type) => allowedAuthTypes === null || allowedAuthTypes.includes(type) || type === savedAuthType
  )

  useEffect(() => {
    if (authOptions.length > 0 && !authOptions.includes(authType)) {
      onAuthTypeChange(authOptions[0])
    }
  }, [authOptions, authType, onAuthTypeChange])

  /** Reset prefill ref when editing so create mode can prefill again on next open. */
  useEffect(() => {
    if (isExistingChat) {
      hasPrefilledSessionEmailRef.current = false
    }
  }, [isExistingChat])

  /**
   * Prefill the signed-in user's email once in create mode when the allowlist is empty.
   * ChipEmailsInput owns chip UX; we only lift the accepted list via onEmailsChange.
   * Re-run if the parent resets emails to [] (e.g. form re-init before session was ready).
   */
  useEffect(() => {
    if (!session?.user?.email || isExistingChat) return
    if (emails.length > 0) {
      hasPrefilledSessionEmailRef.current = true
      return
    }

    const sessionEmail = session.user.email.toLowerCase().trim()
    const validationError = validateAllowlistEntry(sessionEmail)
    if (validationError) return

    hasPrefilledSessionEmailRef.current = true
    onEmailsChange([sessionEmail])
  }, [session?.user?.email, isExistingChat, emails, onEmailsChange])

  return (
    <div className='space-y-[16px]'>
      {/* Access control selector intentionally commented — Arena deploy UX hides it.
      <div>
        <Label className='mb-[6.5px] block pl-0.5 text-small'>Access control</Label>
        <ChipButtonGroup
          value={authType}
          onValueChange={(val) => onAuthTypeChange(val as AuthType)}
          disabled={disabled}
        >
          {authOptions.map((type) => (
            <ChipButtonGroupItem key={type} value={type}>
              {AUTH_LABELS[type]}
            </ChipButtonGroupItem>
          ))}
        </ChipButtonGroup>
      </div>
      */}

      {authType === 'password' && (
        <div>
          <Label className='mb-[6.5px] block pl-0.5 text-small'>Password</Label>
          <GeneratedPasswordInput
            value={password}
            onChange={handlePasswordChange}
            disabled={disabled}
            placeholder={hasExistingPassword ? '' : getPasswordPlaceholder(false)}
            required={!hasExistingPassword}
            fetchCurrentPassword={
              canRevealPassword && chatId && hasExistingPassword
                ? () => revealPasswordMutation.mutateAsync({ chatId })
                : undefined
            }
          />
          {canRevealPassword && revealPasswordMutation.isError && (
            <p className='mt-[6.5px] text-[var(--text-error)] text-caption'>
              Failed to load the current password
            </p>
          )}
          <p className='mt-[6.5px] text-[var(--text-secondary)] text-xs'>
            {getPasswordHelperText(hasExistingPassword)}
          </p>
        </div>
      )}

      {(authType === 'email' || authType === 'sso') && (
        <div>
          <Label className='mb-[6.5px] block pl-0.5 text-small'>
            {authType === 'email' ? 'Allowed emails' : 'Allowed SSO emails'}
          </Label>
          <ChipEmailsInput
            value={emails}
            onChange={onEmailsChange}
            validate={validateAllowlistEntry}
            allowDomains
            placeholder='Enter emails or domains'
            placeholderWithTags='Add email or domain'
            disabled={disabled}
          />
        </div>
      )}

      {error && <p className='mt-[6.5px] text-[var(--text-error)] text-caption'>{error}</p>}
    </div>
  )
}
