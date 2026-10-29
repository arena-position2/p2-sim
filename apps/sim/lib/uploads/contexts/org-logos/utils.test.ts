/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  extractOrganizationIdFromOrgLogoKey,
  generateOrgLogoFileKey,
  ORG_LOGOS_S3_PREFIX,
} from '@/lib/uploads/contexts/org-logos/utils'

describe('org logo storage keys', () => {
  it('builds keys under the SIM_ORG_LOGOS prefix', () => {
    const key = generateOrgLogoFileKey('org-123', 'Company Logo.png')
    expect(key.startsWith(`${ORG_LOGOS_S3_PREFIX}/org-123/`)).toBe(true)
    expect(key).toContain('Company_Logo.png')
  })

  it('extracts the organization id from a storage key', () => {
    expect(extractOrganizationIdFromOrgLogoKey('SIM_ORG_LOGOS/org-abc/123-logo.png')).toBe(
      'org-abc'
    )
    expect(extractOrganizationIdFromOrgLogoKey('workspace-logos/logo.png')).toBeNull()
  })
})
