import { useState } from 'react'
import { Button, cn, Input, Label } from '@sim/emcn'
import { Trash } from '@sim/emcn/icons/trash'
import { createLogger } from '@sim/logger'
import Cookies from 'js-cookie'
import { Check, Copy, Eye, EyeOff, Loader2, Plus, RefreshCw } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { getEnv, isTruthy } from '@/lib/core/config/env'
import { generatePassword } from '@/lib/core/security/encryption'
import type { AuthType } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/deploy/hooks/hooks/use-chat-form'

const logger = createLogger('AuthSelector')

interface AuthSelectorProps {
  authType: AuthType
  password: string
  emails: string[]
  onAuthTypeChange: (type: AuthType) => void
  onPasswordChange: (password: string) => void
  onEmailsChange: (emails: string[]) => void
  disabled?: boolean
  isExistingChat?: boolean
  error?: string
  approvalStatus?: boolean
  nonDeletableEmails?: string[]
  emailValidationErrors?: Set<string>
}

export function AuthSelector({
  authType,
  password,
  emails,
  onPasswordChange,
  onEmailsChange,
  disabled = false,
  isExistingChat = false,
  error,
  approvalStatus = true,
  nonDeletableEmails = [],
  emailValidationErrors = new Set(),
}: AuthSelectorProps) {
  const [showPassword, setShowPassword] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [emailError, setEmailError] = useState('')
  const [copySuccess, setCopySuccess] = useState(false)
  const [isValidatingEmail, setIsValidatingEmail] = useState(false)

  const handleGeneratePassword = () => {
    const password = generatePassword(24)
    onPasswordChange(password)
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopySuccess(true)
    setTimeout(() => setCopySuccess(false), 2000)
  }

  const handleAddEmail = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail) && !newEmail.startsWith('@')) {
      setEmailError('Please enter a valid email or domain (e.g., user@example.com or @example.com)')
      return
    }

    if (emails.includes(newEmail)) {
      setEmailError('This email or domain is already in the list')
      return
    }

    // Check email limit for non-approved status
    if (!approvalStatus) {
      const sessionEmail = Cookies.get('email')
      const deletableEmails = emails.filter((e) => e !== sessionEmail && e !== '@position2.com')
      if (deletableEmails.length >= 5) {
        setEmailError('Maximum 5 additional emails allowed (excluding session email)')
        return
      }
    }

    // Validate email exists in user database (for non-domain emails)
    if (!newEmail.startsWith('@')) {
      setIsValidatingEmail(true)
      setEmailError('')
      try {
        const response = await fetch('/api/users/validate-emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emails: [newEmail.toLowerCase()] }),
        })

        if (!response.ok) {
          setEmailError('Failed to validate email. Please try again.')
          setIsValidatingEmail(false)
          return
        }

        const result = await response.json()

        // Check if email is missing from the user database
        if (!result.valid || (result.missingEmails && result.missingEmails.length > 0)) {
          setEmailError(`${newEmail} does not have access to Agentic AI yet`)
          setIsValidatingEmail(false)
          return
        }
      } catch (error) {
        // Block on validation error to prevent invalid emails
        logger.error('Error validating email', { error })
        setEmailError('Failed to validate email. Please try again.')
        setIsValidatingEmail(false)
        return
      } finally {
        setIsValidatingEmail(false)
      }
    }

    // Only add email if validation passed
    onEmailsChange([...emails, newEmail])
    setNewEmail('')
    setEmailError('')
  }

  const handleRemoveEmail = (email: string) => {
    // Prevent deletion of non-deletable emails
    if (nonDeletableEmails.includes(email)) {
      return
    }
    onEmailsChange(emails.filter((e) => e !== email))
  }

  const ssoEnabled = isTruthy(getEnv('NEXT_PUBLIC_SSO_ENABLED'))

  return (
    <div className='space-y-2'>
      <Label className='font-medium text-sm'>Access Control</Label>

      {/* Auth Type Selection */}
      <div
        className={cn('grid grid-cols-1 gap-3', ssoEnabled ? 'md:grid-cols-4' : 'md:grid-cols-3')}
      >
        {/* {authOptions.map((type) => (
          <Card
            key={type}
            className={cn(
              'cursor-pointer overflow-hidden rounded-[4px] shadow-none transition-all duration-200',
              authType === type
                ? 'border border-[#727272] bg-[var(--border-strong)] dark:border-[#727272] dark:bg-[var(--border-strong)]'
                : 'border border-[var(--surface-11)] bg-[var(--surface-6)] hover:bg-[var(--surface-9)] dark:bg-[var(--surface-9)] dark:hover:bg-[var(--surface-11)]'
            )}
          >
            <CardContent className='relative flex flex-col items-center justify-center p-3 text-center'>
              <button
                type='button'
                className='absolute inset-0 z-10 h-full w-full cursor-pointer'
                onClick={() => !disabled && onAuthTypeChange(type)}
                aria-label={`Select ${type} access`}
                disabled={disabled}
              />
              <div className='justify-center text-center align-middle'>
                <h3
                  className={cn(
                    'font-medium text-xs',
                    authType === type && 'text-[var(--text-primary)]'
                  )}
                >
                  {type === 'public' && 'Public Access'}
                  {type === 'password' && 'Password Protected'}
                  {type === 'email' && 'Email Access'}
                  {type === 'sso' && 'SSO Access'}
                </h3>
                <p className='text-[11px] text-[var(--text-tertiary)]'>
                  {type === 'public' && 'Anyone can access your chat'}
                  {type === 'password' && 'Secure with a single password'}
                  {type === 'email' && 'Restrict to specific emails'}
                  {type === 'sso' && 'Authenticate via SSO provider'}
                </p>
              </div>
            </CardContent>
          </Card>
        ))} */}
      </div>

      {/* Auth Settings */}
      {authType === 'password' && (
        <Card className='rounded-[4px] border-[var(--surface-11)] bg-[var(--surface-6)] shadow-none dark:bg-[var(--surface-9)]'>
          <CardContent className='p-4'>
            <h3 className='mb-2 font-medium text-[var(--text-primary)] text-xs'>
              Password Settings
            </h3>

            {isExistingChat && !password && (
              <div className='mb-2 flex items-center text-[11px] text-[var(--text-secondary)]'>
                <div className='mr-2 rounded-full bg-[var(--surface-9)] px-2 py-0.5 font-medium text-[var(--text-secondary)] dark:bg-[var(--surface-11)]'>
                  Password set
                </div>
                <span>Current password is securely stored</span>
              </div>
            )}

            <div className='relative'>
              <Input
                type={showPassword ? 'text' : 'password'}
                placeholder={
                  isExistingChat
                    ? 'Enter new password (leave empty to keep current)'
                    : 'Enter password'
                }
                value={password}
                onChange={(e) => onPasswordChange(e.target.value)}
                disabled={disabled}
                className='pr-28'
                required={!isExistingChat}
                autoComplete='new-password'
              />
              <div className='-translate-y-1/2 absolute top-1/2 right-1 flex items-center gap-1'>
                <Button
                  type='button'
                  variant='ghost'
                  onClick={handleGeneratePassword}
                  disabled={disabled}
                  className='h-6 w-6 p-0'
                >
                  <RefreshCw className='h-3.5 w-3.5 transition-transform duration-200 hover:rotate-90' />
                  <span className='sr-only'>Generate password</span>
                </Button>
                <Button
                  type='button'
                  variant='ghost'
                  onClick={() => copyToClipboard(password)}
                  disabled={!password || disabled}
                  className='h-6 w-6 p-0'
                >
                  {copySuccess ? (
                    <Check className='h-3.5 w-3.5' />
                  ) : (
                    <Copy className='h-3.5 w-3.5' />
                  )}
                  <span className='sr-only'>Copy password</span>
                </Button>
                <Button
                  type='button'
                  variant='ghost'
                  onClick={() => setShowPassword(!showPassword)}
                  disabled={disabled}
                  className='h-6 w-6 p-0'
                >
                  {showPassword ? (
                    <EyeOff className='h-3.5 w-3.5' />
                  ) : (
                    <Eye className='h-3.5 w-3.5' />
                  )}
                  <span className='sr-only'>
                    {showPassword ? 'Hide password' : 'Show password'}
                  </span>
                </Button>
              </div>
            </div>

            <p className='mt-2 text-[11px] text-[var(--text-secondary)]'>
              {isExistingChat
                ? 'Leaving this empty will keep the current password. Enter a new password to change it.'
                : 'This password will be required to access your chat.'}
            </p>
          </CardContent>
        </Card>
      )}

      {(authType === 'email' || authType === 'sso') && (
        <Card className='rounded-[4px] border-[var(--surface-11)] bg-[var(--surface-6)] shadow-none dark:bg-[var(--surface-9)]'>
          <CardContent className='p-4'>
            <h3 className='mb-2 font-medium text-[var(--text-primary)] text-xs'>
              {authType === 'email' ? 'Email Access Settings' : 'SSO Access Settings'}
            </h3>

            <div className='flex gap-2'>
              <Input
                placeholder='user@example.com or @domain.com'
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                disabled={disabled}
                className='flex-1'
                onKeyDown={async (e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    await handleAddEmail()
                  }
                }}
              />
              <Button
                type='button'
                variant='default'
                onClick={handleAddEmail}
                disabled={!newEmail.trim() || disabled || isValidatingEmail}
                className='shrink-0 gap-[4px]'
              >
                {isValidatingEmail ? (
                  <Loader2 className='h-4 w-4 animate-spin' />
                ) : (
                  <Plus className='h-4 w-4' />
                )}
                Add
              </Button>
            </div>

            {emailError && <p className='mt-1 text-destructive text-sm'>{emailError}</p>}

            {emails.length > 0 && (
              <div className='mt-3 max-h-[150px] overflow-y-auto rounded-md border bg-background px-2 py-0 shadow-none'>
                <ul className='divide-y divide-border'>
                  {emails.map((email) => {
                    const isNonDeletable = nonDeletableEmails.includes(email)
                    const hasValidationError = emailValidationErrors.has(email)
                    return (
                      <li key={email} className='relative'>
                        <div className='group my-1 flex items-center justify-between rounded-sm px-2 py-2 text-sm'>
                          <div className='flex flex-1 flex-col'>
                            <span
                              className={cn(
                                'font-medium',
                                hasValidationError ? 'text-destructive' : 'text-foreground'
                              )}
                            >
                              {email}
                            </span>
                            {hasValidationError && (
                              <span className='text-destructive text-xs'>
                                Does not have access to Agentic AI yet
                              </span>
                            )}
                            {isNonDeletable && (
                              <span className='text-muted-foreground text-xs'>Required</span>
                            )}
                          </div>
                          {!isNonDeletable && (
                            <Button
                              type='button'
                              variant='ghost'
                              onClick={() => handleRemoveEmail(email)}
                              disabled={disabled}
                              className='h-7 w-7 p-0 opacity-70'
                            >
                              <Trash className='h-4 w-4' />
                            </Button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            <p className='mt-2 text-[11px] text-[var(--text-secondary)]'>
              {!approvalStatus
                ? `Add up to 5 additional emails (excluding session email). All emails must have access to Agentic AI.`
                : authType === 'email'
                  ? 'Add specific emails or entire domains (@example.com)'
                  : 'Add specific emails or entire domains (@example.com) that can access via SSO'}
            </p>
          </CardContent>
        </Card>
      )}

      {authType === 'public' && (
        <Card className='rounded-[4px] border-[var(--surface-11)] bg-[var(--surface-6)] shadow-none dark:bg-[var(--surface-9)]'>
          <CardContent className='p-4'>
            <h3 className='mb-2 font-medium text-[var(--text-primary)] text-xs'>
              Public Access Settings
            </h3>
            <p className='text-[11px] text-[var(--text-secondary)]'>
              This chat will be publicly accessible to anyone with the link.
            </p>
          </CardContent>
        </Card>
      )}

      {error && <p className='text-destructive text-sm'>{error}</p>}
    </div>
  )
}
