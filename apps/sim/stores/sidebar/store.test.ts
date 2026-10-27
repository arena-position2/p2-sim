/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SIDEBAR_WIDTH } from '@/stores/constants'
import { getMaxSidebarWidth, readCollapsedCookie, useSidebarStore } from '@/stores/sidebar/store'

function setCookie(value: string) {
  document.cookie = `sidebar_collapsed=${value}; path=/`
}

function widthVars() {
  const style = document.documentElement.style
  return {
    width: style.getPropertyValue('--sidebar-width'),
    expanded: style.getPropertyValue('--sidebar-expanded-width'),
  }
}

afterEach(() => {
  document.cookie = 'sidebar_collapsed=; path=/; max-age=0'
})

describe('readCollapsedCookie', () => {
  it('does not treat a substring value like 10 as collapsed', () => {
    setCookie('10')
    expect(readCollapsedCookie()).toBe(false)
  })
})

describe('sidebar width CSS variables', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--sidebar-width')
    document.documentElement.style.removeProperty('--sidebar-expanded-width')
    useSidebarStore.setState({ isCollapsed: false, sidebarWidth: SIDEBAR_WIDTH.DEFAULT })
  })

  it('publishes both variables when the width changes while expanded', () => {
    useSidebarStore.getState().setSidebarWidth(300)
    expect(widthVars()).toEqual({ width: '300px', expanded: '300px' })
  })

  it('clamps a drag below the minimum back up to the minimum', () => {
    useSidebarStore.getState().setSidebarWidth(SIDEBAR_WIDTH.MIN)
    expect(useSidebarStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.MIN)
    expect(SIDEBAR_WIDTH.MIN).toBe(SIDEBAR_WIDTH.DEFAULT)

    useSidebarStore.getState().setSidebarWidth(SIDEBAR_WIDTH.MIN - 1)
    expect(useSidebarStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH.MIN)
  })

  it('keeps the expanded variable at the restore width while collapsed', () => {
    useSidebarStore.getState().setSidebarWidth(300)
    useSidebarStore.getState().toggleCollapsed()

    expect(useSidebarStore.getState().isCollapsed).toBe(true)
    expect(widthVars()).toEqual({
      width: `${SIDEBAR_WIDTH.COLLAPSED}px`,
      expanded: '300px',
    })
  })

  it('restores the collapsed width from the expanded variable on expand', () => {
    useSidebarStore.getState().setSidebarWidth(300)
    useSidebarStore.getState().toggleCollapsed()
    useSidebarStore.getState().toggleCollapsed()

    expect(widthVars()).toEqual({ width: '300px', expanded: '300px' })
  })

  it('holds the expanded width across a syncWidth while collapsed', () => {
    useSidebarStore.getState().setSidebarWidth(300)
    useSidebarStore.getState().toggleCollapsed()
    document.documentElement.style.removeProperty('--sidebar-expanded-width')

    useSidebarStore.getState().syncWidth()

    expect(widthVars()).toEqual({
      width: `${SIDEBAR_WIDTH.COLLAPSED}px`,
      expanded: '300px',
    })
  })

  it('clamps a below-minimum persisted width into the expanded variable', () => {
    useSidebarStore.setState({ isCollapsed: true, sidebarWidth: 10 })

    useSidebarStore.getState().syncWidth()

    expect(widthVars().expanded).toBe(`${SIDEBAR_WIDTH.MIN}px`)
  })

  it('preserves the restore width when the viewport narrows while collapsed', () => {
    const innerWidth = window.innerWidth
    try {
      window.innerWidth = 1200
      useSidebarStore.getState().setSidebarWidth(300)
      useSidebarStore.getState().toggleCollapsed()
      window.innerWidth = 800
      useSidebarStore.getState().syncWidth()

      expect(widthVars().expanded).toBe('240px')
      expect(useSidebarStore.getState().sidebarWidth).toBe(300)

      window.innerWidth = 1200
      useSidebarStore.getState().syncWidth()
      useSidebarStore.getState().toggleCollapsed()
      expect(widthVars()).toEqual({ width: '300px', expanded: '300px' })
    } finally {
      window.innerWidth = innerWidth
    }
  })
})

describe('getMaxSidebarWidth', () => {
  it('scales with the viewport below the cap', () => {
    expect(getMaxSidebarWidth(1000)).toBe(1000 * SIDEBAR_WIDTH.MAX_PERCENTAGE)
  })

  it('scales a wide viewport by the percentage, floored at the minimum', () => {
    expect(getMaxSidebarWidth(4000)).toBe(4000 * SIDEBAR_WIDTH.MAX_PERCENTAGE)
  })

  it('never drops below the minimum on a narrow viewport', () => {
    expect(getMaxSidebarWidth(400)).toBe(SIDEBAR_WIDTH.MIN)
  })
})
