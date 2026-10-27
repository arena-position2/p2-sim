'use client'

import { AgentAccessRequest } from '@/app/workspace/[workspaceId]/settings/components/agent-access-request/agent-access-request'

/** Client shell for the top-level `/agent-access-request` inbox (no settings left nav). */
export function AgentAccessRequestPage() {
  return <AgentAccessRequest standalone />
}
