import { useCallback, useEffect, useState } from 'react'
import { createLogger } from '@sim/logger'
import Cookies from 'js-cookie'

const logger = createLogger('ChatForm')

export type AuthType = 'public' | 'password' | 'email' | 'sso'

export interface ChatFormData {
  identifier: string
  title: string
  description: string
  authType: AuthType
  password: string
  emails: string[]
  welcomeMessage: string
  selectedOutputBlocks: string[]
  approvalStatus: boolean
}

export interface ChatFormErrors {
  identifier?: string
  title?: string
  password?: string
  emails?: string
  outputBlocks?: string
  general?: string
}

const initialFormData: ChatFormData = {
  identifier: '',
  title: '',
  description: '',
  authType: 'email',
  password: '',
  emails: [],
  welcomeMessage:
    "How can I help you today? I'm here to answer your questions and assist you with anything you need.",
  selectedOutputBlocks: [],
  approvalStatus: true, // Default to approved
}

export function useChatForm(initialData?: Partial<ChatFormData>) {
  const [formData, setFormData] = useState<ChatFormData>({
    ...initialFormData,
    ...initialData,
    approvalStatus: initialData?.approvalStatus ?? true,
  })

  const [errors, setErrors] = useState<ChatFormErrors>({})
  const [emailValidationErrors, setEmailValidationErrors] = useState<Set<string>>(new Set())

  // Initialize emails based on approvalStatus
  useEffect(() => {
    if (formData.approvalStatus) {
      // Approved: Prefill @position2.com domain (non-deletable)
      const position2Domain = '@position2.com'
      if (!formData.emails.includes(position2Domain)) {
        setFormData((prev) => ({
          ...prev,
          emails: [position2Domain],
        }))
      }
    } else {
      // Not approved: Get email from cookies and prefill (non-deletable)
      const sessionEmail = Cookies.get('email')
      if (sessionEmail) {
        // Only add if not already present and ensure it's first
        if (!formData.emails.includes(sessionEmail)) {
          setFormData((prev) => ({
            ...prev,
            emails: [
              sessionEmail,
              ...prev.emails.filter((e) => e !== sessionEmail && e !== '@position2.com'),
            ],
          }))
        } else if (formData.emails[0] !== sessionEmail) {
          // Reorder to put session email first
          setFormData((prev) => ({
            ...prev,
            emails: [sessionEmail, ...prev.emails.filter((e) => e !== sessionEmail)],
          }))
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.approvalStatus])

  const updateField = useCallback(
    <K extends keyof ChatFormData>(field: K, value: ChatFormData[K]) => {
      setFormData((prev) => ({ ...prev, [field]: value }))
      // Clear error when user starts typing
      if (field in errors && errors[field as keyof ChatFormErrors]) {
        setErrors((prev) => ({ ...prev, [field]: undefined }))
      }
    },
    [errors]
  )

  const setError = useCallback((field: keyof ChatFormErrors, message: string) => {
    setErrors((prev) => ({ ...prev, [field]: message }))
  }, [])

  const clearError = useCallback((field: keyof ChatFormErrors) => {
    setErrors((prev) => ({ ...prev, [field]: undefined }))
  }, [])

  const clearAllErrors = useCallback(() => {
    setErrors({})
  }, [])

  const validateForm = useCallback(async (): Promise<boolean> => {
    const newErrors: ChatFormErrors = {}

    if (!formData.identifier.trim()) {
      newErrors.identifier = 'Identifier is required'
    } else if (!/^[a-z0-9-]+$/.test(formData.identifier)) {
      newErrors.identifier = 'Identifier can only contain lowercase letters, numbers, and hyphens'
    }

    if (!formData.title.trim()) {
      newErrors.title = 'Title is required'
    }

    if (formData.authType === 'password' && !formData.password.trim()) {
      newErrors.password = 'Password is required when using password protection'
    }

    if (formData.authType === 'email' && formData.emails.length === 0) {
      newErrors.emails = 'At least one email or domain is required when using email access control'
    }

    if (formData.authType === 'sso' && formData.emails.length === 0) {
      newErrors.emails = 'At least one email or domain is required when using SSO access control'
    }

    // Validate email limits and user existence for non-approved status
    if (
      !formData.approvalStatus &&
      (formData.authType === 'email' || formData.authType === 'sso')
    ) {
      const sessionEmail = Cookies.get('email')

      // Check total email limit (5 additional + 1 session email = 6 total)
      if (formData.emails.length > 6) {
        newErrors.emails = 'Maximum 6 emails allowed (1 session email + 5 additional emails)'
      }

      // Validate that all emails (except domains) exist in user database
      const emailsToValidate = formData.emails.filter(
        (email) => !email.startsWith('@') && email !== sessionEmail
      )

      if (emailsToValidate.length > 0) {
        try {
          const response = await fetch('/api/users/validate-emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emails: emailsToValidate }),
          })

          if (response.ok) {
            const result = await response.json()
            if (!result.valid && result.missingEmails.length > 0) {
              const missingEmailsList = result.missingEmails.join(', ')
              newErrors.emails = `${missingEmailsList} ${
                result.missingEmails.length === 1 ? 'does' : 'do'
              } not have access to Agentic AI yet`
              setEmailValidationErrors(new Set(result.missingEmails))
            } else {
              setEmailValidationErrors(new Set())
            }
          }
        } catch (error) {
          logger.error('Error validating emails:', error)
          // Don't block form submission on validation error
        }
      }
    }

    if (formData.selectedOutputBlocks.length === 0) {
      newErrors.outputBlocks = 'Please select at least one output block'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }, [formData])

  const resetForm = useCallback(() => {
    setFormData(initialFormData)
    setErrors({})
  }, [])

  return {
    formData,
    errors,
    updateField,
    setError,
    clearError,
    clearAllErrors,
    validateForm,
    resetForm,
    setFormData,
    emailValidationErrors,
  }
}
