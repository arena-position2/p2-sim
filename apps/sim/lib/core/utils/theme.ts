/**
 * Theme synchronization utilities for managing theme across next-themes and database
 */

/**
 * Updates the theme by writing the account-synced `sim-theme` key and
 * dispatching a storage event so the document ThemeProvider applies it. User
 * settings load and save go through this path from the database.
 * @param theme - The desired theme ('system', 'light', or 'dark')
 */
export function syncThemeToNextThemes(theme: 'light' | 'dark' | 'system') {
  if (typeof window === 'undefined') return

  const oldValue = localStorage.getItem('sim-theme')
  if (oldValue !== theme) {
    localStorage.setItem('sim-theme', theme)

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'sim-theme',
        newValue: theme,
        oldValue,
        storageArea: localStorage,
        url: window.location.href,
      })
    )
  }
}

/**
 * Reads the visitor color scheme from the account-synced `sim-theme` key.
 * A missing value and `system` resolve to light, matching the generative-app host.
 */
export function getThemeFromNextThemes(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light'
  return localStorage.getItem('sim-theme') === 'dark' ? 'dark' : 'light'
}
