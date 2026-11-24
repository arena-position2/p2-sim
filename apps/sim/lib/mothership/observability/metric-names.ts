// Sim-owned: edit here; the mothership worker does not sync this file.

// Canonical mothership OTel metric names Sim emits. Names only: label keys and histogram
// buckets are the emitter's.

export const Metric = {
  CopilotDegradedCount: 'copilot.degraded.count',
  CopilotFileReadDuration: 'copilot.file.read.duration',
  CopilotFileReadSize: 'copilot.file.read.size',
  CopilotToolCalls: 'copilot.tool.calls',
  CopilotToolDuration: 'copilot.tool.duration',
} as const
