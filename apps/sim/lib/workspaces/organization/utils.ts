/**
 * Utility functions for organization-related operations
 * These are pure functions that compute values from organization data
 */

import { isOrgAdminRole } from '@sim/platform-authz/predicates'
import type { Member } from '@/lib/workspaces/organization/types'

interface OrganizationMembers {
  members?: Member[]
}

export function isAdminOrOwner(
  organization: OrganizationMembers | null | undefined,
  userEmail?: string
): boolean {
  if (!userEmail || !organization?.members) return false
  const role =
    organization.members.find((member) => member.user?.email === userEmail)?.role ?? 'member'
  return isOrgAdminRole(role)
}

/**
 * Generate a URL-friendly slug from a name
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-') // Replace non-alphanumeric with hyphens
    .replace(/-+/g, '-') // Replace consecutive hyphens with single hyphen
    .replace(/^-|-$/g, '') // Remove leading and trailing hyphens
}
