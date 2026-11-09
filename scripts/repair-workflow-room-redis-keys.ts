#!/usr/bin/env bun
/**
 * Scan Redis for collaborative workflow room keys with the wrong TYPE and repair them.
 *
 * Realtime expects:
 *   workflow:{workflowId}:users  → HASH
 *   workflow:{workflowId}:meta   → HASH
 *
 * A STRING (or other type) at `workflow:*:users` causes WRONGTYPE on HSET/HLEN and
 * leaves the editor stuck on "Joining workflow..." for that workflow only.
 *
 * Usage:
 *   REDIS_URL=redis://... bun run scripts/repair-workflow-room-redis-keys.ts
 *   REDIS_URL=redis://... bun run scripts/repair-workflow-room-redis-keys.ts --fix
 *   REDIS_URL=redis://... bun run scripts/repair-workflow-room-redis-keys.ts --workflow-id <uuid>
 *
 * Default mode is dry-run (report only). Pass --fix to DELETE corrupted keys.
 */
import { createClient } from 'redis'
import {
  findCorruptedWorkflowRoomKeys,
  healCorruptedWorkflowRoomKeys,
  parseWorkflowIdFromUsersKey,
  WORKFLOW_USERS_SCAN_PATTERN,
  workflowMetaKey,
} from '../apps/realtime/src/rooms/workflow-room-keys.ts'

interface CliOptions {
  fix: boolean
  workflowId?: string
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { fix: false }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--fix') {
      options.fix = true
      continue
    }
    if (arg === '--workflow-id') {
      const workflowId = argv[index + 1]
      if (!workflowId) {
        throw new Error('--workflow-id requires a workflow UUID')
      }
      options.workflowId = workflowId
      index++
      continue
    }
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  REDIS_URL=redis://... bun run scripts/repair-workflow-room-redis-keys.ts [--fix] [--workflow-id <uuid>]

Options:
  --fix             Delete corrupted keys (default: dry-run report only)
  --workflow-id     Check/repair a single workflow instead of scanning all keys
`)
      process.exit(0)
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

async function scanAllWorkflowUsersKeys(redis: ReturnType<typeof createClient>): Promise<string[]> {
  const keys: string[] = []
  let cursor = '0'

  do {
    const result = await redis.scan(cursor, {
      MATCH: WORKFLOW_USERS_SCAN_PATTERN,
      COUNT: 200,
    })
    cursor = String(result.cursor)
    keys.push(...result.keys)
  } while (cursor !== '0')

  return keys
}

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) {
    console.error('REDIS_URL is required')
    process.exit(1)
  }

  const options = parseArgs(process.argv.slice(2))
  const redis = createClient({ url: redisUrl })
  await redis.connect()

  try {
    const workflowIds = new Set<string>()

    if (options.workflowId) {
      workflowIds.add(options.workflowId)
    } else {
      const usersKeys = await scanAllWorkflowUsersKeys(redis)
      for (const key of usersKeys) {
        const workflowId = parseWorkflowIdFromUsersKey(key)
        if (workflowId) {
          workflowIds.add(workflowId)
        }
      }
    }

    const corruptedByWorkflow = new Map<
      string,
      Awaited<ReturnType<typeof findCorruptedWorkflowRoomKeys>>
    >()

    for (const workflowId of workflowIds) {
      const corrupted = await findCorruptedWorkflowRoomKeys(redis, workflowId)
      if (corrupted.length > 0) {
        corruptedByWorkflow.set(workflowId, corrupted)
      }
    }

    if (corruptedByWorkflow.size === 0) {
      console.log(
        options.workflowId
          ? `No corrupted workflow room keys found for ${options.workflowId}.`
          : `Scanned ${workflowIds.size} workflow room(s); no corrupted keys found.`
      )
      return
    }

    console.log(`Found corrupted workflow room keys for ${corruptedByWorkflow.size} workflow(s):\n`)

    for (const [workflowId, corrupted] of corruptedByWorkflow) {
      console.log(`workflow ${workflowId}`)
      for (const entry of corrupted) {
        console.log(`  - ${entry.key}: expected ${entry.expectedType}, got ${entry.actualType}`)
        if (entry.preview) {
          console.log(`    preview: ${entry.preview}`)
        }
      }
      const metaKey = workflowMetaKey(workflowId)
      const metaType = await redis.type(metaKey)
      if (metaType !== 'none' && metaType !== 'hash') {
        console.log(`  - ${metaKey}: expected hash, got ${metaType}`)
      }
      console.log('')
    }

    if (!options.fix) {
      console.log('Dry run only. Re-run with --fix to delete corrupted keys.')
      return
    }

    let deletedCount = 0
    for (const workflowId of corruptedByWorkflow.keys()) {
      const result = await healCorruptedWorkflowRoomKeys(redis, workflowId)
      deletedCount += result.deletedKeys.length
      console.log(`Repaired ${workflowId}: deleted ${result.deletedKeys.join(', ') || '(none)'}`)
    }

    console.log(`\nDeleted ${deletedCount} corrupted key(s).`)
  } finally {
    await redis.quit()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
