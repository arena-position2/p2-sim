import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSettingsSectionMeta } from '@/components/settings/navigation'
import { getSession } from '@/lib/auth'
import { ArenaGeneralSettingsShell } from '@/app/workspace/arena-general-settings/arena-general-settings-shell'

const generalMeta = getSettingsSectionMeta('account', 'general')

export const metadata: Metadata = {
  title: generalMeta?.label ?? 'General',
}

export default async function ArenaGeneralSettingsLayout({ children }: { children: ReactNode }) {
  const session = await getSession()
  if (!session?.user) redirect('/login')

  return (
    <ArenaGeneralSettingsShell
      meta={{
        label: generalMeta?.label ?? 'General',
        description: generalMeta?.description ?? 'Manage your profile, appearance, and preferences.',
        docsLink: generalMeta?.docsLink,
      }}
    >
      {children}
    </ArenaGeneralSettingsShell>
  )
}
