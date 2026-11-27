import type { BrandConfig } from './types'

/** Canonical Arena terms URL until in-app legal pages are restored. */
export const DEFAULT_TERMS_URL = 'https://thearena.ai/terms'

/** Canonical Arena privacy URL until in-app legal pages are restored. */
export const DEFAULT_PRIVACY_URL = 'https://thearena.ai/privacy'

/**
 * Default brand configuration values
 */
export const defaultBrandConfig: BrandConfig = {
  name: 'Agentic AI Builder | Arena',
  logoUrl: 'https://arenav2image.s3.us-west-1.amazonaws.com/ArenaLogo.svg',
  logoUrlBlacktext:
    'https://arenav2image.s3.us-west-1.amazonaws.com/rt/calibrate/Arena_Logo_WebDashboard.svg',
  wordmarkUrl:
    'https://arenav2image.s3.us-west-1.amazonaws.com/rt/calibrate/Arena_Logo_WebDashboard.svg',
  faviconUrl: 'https://arenav2image.s3.us-west-1.amazonaws.com/ArenaLogo.svg',
  customCssUrl: undefined,
  supportEmail: 'arenadeveloper@position2.com',
  documentationUrl: undefined,
  termsUrl: DEFAULT_TERMS_URL,
  privacyUrl: DEFAULT_PRIVACY_URL,
  theme: {
    primaryColor: '#1a73e8',
    primaryHoverColor: '#155cba',
    secondaryColor: '#488fed',
    accentColor: '#76abf1',
    accentHoverColor: '#a3c7f6',
    backgroundColor: '#F3F8FE',
  },
  isWhitelabeled: false,
}
