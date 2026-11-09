import { createLogger } from '@sim/logger'
import Cookies from 'js-cookie'
import mixpanel from 'mixpanel-browser'
import { getEnv } from '@/lib/core/config/env'

const logger = createLogger('Mixpanel')

/**
 * Gets the Mixpanel token from environment variables
 * @returns Mixpanel token string or undefined
 */
const getMixpanelToken = () => {
  return getEnv('NEXT_PUBLIC_MIX_PANEL_TOKEN')
}

// Initialize mixpanel only if we have a valid token and we're in the browser
if (typeof window !== 'undefined' && mixpanel) {
  try {
    const token = getMixpanelToken()
    if (token && typeof mixpanel.init === 'function') {
      mixpanel.init(token)
    }
  } catch (error) {
    logger.warn('Failed to initialize Mixpanel:', error)
  }
}

export { mixpanel }

const osIdentifier = () => {
  let OSName = 'Unknown OS'
  if (navigator.appVersion.indexOf('Win') !== -1) OSName = 'Windows'
  if (navigator.appVersion.indexOf('Mac') !== -1) OSName = 'MacOS'
  if (navigator.appVersion.indexOf('X11') !== -1) OSName = 'UNIX'
  if (navigator.appVersion.indexOf('Linux') !== -1) OSName = 'Linux'
  return OSName
}

export const identityMP = (name: string) => {
  if (!mixpanel || typeof window === 'undefined') {
    return
  }

  try {
    if (typeof mixpanel.identify === 'function') {
      mixpanel.identify(name)
    }
  } catch (error) {
    logger.warn('Failed to identify user in Mixpanel:', error)
  }
}

export const registerMP = (instanceValue: string | null | number) => {
  if (!mixpanel || typeof window === 'undefined') {
    return
  }

  try {
    if (typeof mixpanel.register === 'function') {
      mixpanel.register({
        instance: instanceValue,
      })
    }
  } catch (error) {
    logger.warn('Failed to register properties in Mixpanel:', error)
  }
}

const getPlatformVersion = () => {
  return navigator.userAgent.match(/Windows NT (\d+\.\d+)/)?.[1] || ''
}

export const setPeople = async ({
  email,
  name,
  organizationRole,
  userType,
  department,
}: {
  email: string
  name: string
  id: string
  organizationId: string
  organizationRole: string
  userType: string
  department: string
}) => {
  if (!mixpanel || typeof window === 'undefined') {
    return
  }

  const appUrl = getEnv('NEXT_PUBLIC_APP_URL') || ''
  const platformVersion = getPlatformVersion()

  // Determine instance based on NEXT_PUBLIC_APP_URL
  const instanceMap: Record<string, string> = {
    'https://agent.thearena.ai': 'Prod',
    'https://sandbox-agent.thearena.ai': 'Sandbox',
    'https://test-agent.thearena.ai': 'Test',
    'https://test-v1-agent.thearena.ai': 'Test V1',
    'https://dev-agent.thearena.ai': 'Dev',
  }
  registerMP(instanceMap[appUrl] || 'Dev')

  try {
    if (!mixpanel.people || typeof mixpanel.people.set !== 'function') {
      return
    }

    if (email) {
      mixpanel.people.set({
        $email: email,
        $name: name || '',
        $os_version: platformVersion,
        'User Type': userType === 'client_stakeholder' ? 'External' : 'Internal',
        'Flow Type': 'Agents',
        Department: department || '',
        isActive: true,
        'Organisation Role': organizationRole || '',
      })
      identityMP(email)
    } else {
      mixpanel.people.set({
        $name: 'Guest User',
        $os_version: platformVersion,
      })
      identityMP('Guest User')
    }
  } catch (error) {
    logger.warn('Failed to set people properties in Mixpanel:', error)
  }
}

export const trackMp = async (PageName?: string, eventName?: string, properties?: any) => {
  if (!mixpanel || typeof window === 'undefined' || !eventName) {
    return
  }

  const userEmail = Cookies.get('email') || 'Guest User'
  identityMP(userEmail)

  try {
    if (PageName && typeof mixpanel.register === 'function') {
      mixpanel.register({ 'Page Name': PageName })
    }

    if (typeof mixpanel.track === 'function') {
      const eventProperties = {
        ...properties,
        $os: osIdentifier(),
        $referring_domain: window.location.hostname,
      }
      mixpanel.track(eventName, eventProperties)
    }
  } catch (error) {
    logger.warn('Failed to track event in Mixpanel:', error)
  }
}

export const fetchUserProfileSetPeopleMP = async () => {
  try {
    const response = await fetch('/api/users/me/profile')
    const data = await response.json()
    const user = data?.user

    if (user) {
      await setPeople({
        email: user.email || '',
        name: user.name || '',
        id: user.id || '',
        organizationId: user.organizationId || '',
        organizationRole: user.organizationRole || '',
        userType: user.userType || '',
        department: user.department || '',
      })
    }
  } catch (error) {
    logger.warn('Failed to fetch user profile for Mixpanel:', error)
  }
}
