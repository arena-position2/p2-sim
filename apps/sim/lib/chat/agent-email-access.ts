/**
 * Returns true when allowedEmails has at least one string whose first character is '@'
 * (e.g. '@position2.com', '@northstar'). Ignores email-style entries (e.g. saiteja.s@position2.com).
 */
export function hasAllowedEmailStartingWithAtSymbol(
  allowedEmails: unknown,
  userEmailDomain: string
): boolean {
  const list = Array.isArray(allowedEmails) ? allowedEmails : []
  const commonEmailDomains = ['@gmail.com', '@yahoo.com', '@hotmail.com', '@outlook.com']
  return list.some(
    (entry) =>
      typeof entry === 'string' &&
      entry.length > 0 &&
      entry.startsWith(userEmailDomain) &&
      !commonEmailDomains.includes(userEmailDomain)
  )
}

/** True when emailId appears exactly in the chat's allowedEmails array. */
export function isExactEmailInAllowedEmails(allowedEmails: unknown, emailId: string): boolean {
  const list = Array.isArray(allowedEmails) ? allowedEmails : []
  return list.includes(emailId)
}

/**
 * True when the user can access the agent via allowedEmails:
 * exact email match, or domain pattern match (e.g. `@position2.com`).
 */
export function hasAgentEmailAccess(allowedEmails: unknown, emailId: string): boolean {
  if (isExactEmailInAllowedEmails(allowedEmails, emailId)) return true
  const domain = emailId.includes('@') ? `@${emailId.split('@')[1]}` : ''
  if (!domain || domain === '@') return false
  return hasAllowedEmailStartingWithAtSymbol(allowedEmails, domain)
}
