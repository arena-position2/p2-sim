const POSTGRES_BLOCK_TYPE = 'postgresql'

export interface PostgresConnectionConfig {
  host: string
  port: string
  database: string
  username: string
  password: string
  ssl: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function setSubBlockValue(subBlocks: Record<string, unknown>, subBlockId: string, value: string) {
  const existing = subBlocks[subBlockId]
  if (isRecord(existing)) {
    existing.value = value
    return
  }

  subBlocks[subBlockId] = {
    id: subBlockId,
    type: subBlockId === 'ssl' ? 'dropdown' : 'short-input',
    value,
  }
}

/**
 * Parses optional Postgres connection settings from an admin API request body.
 */
export function parsePostgresConnectionFromBody(
  body: Record<string, unknown>
): PostgresConnectionConfig | undefined | { error: string } {
  const raw = body.postgres ?? body.postgresConnection
  return parsePostgresConnection(raw)
}

/**
 * Validates Postgres connection settings supplied on import/sync requests.
 */
export function parsePostgresConnection(
  raw: unknown
): PostgresConnectionConfig | undefined | { error: string } {
  if (raw === undefined || raw === null) {
    return undefined
  }

  if (!isRecord(raw)) {
    return { error: 'postgres must be a JSON object.' }
  }

  const host = typeof raw.host === 'string' ? raw.host.trim() : ''
  const database = typeof raw.database === 'string' ? raw.database.trim() : ''
  const username = typeof raw.username === 'string' ? raw.username.trim() : ''
  const password = typeof raw.password === 'string' ? raw.password : ''

  if (!host) {
    return { error: 'postgres.host is required.' }
  }
  if (!database) {
    return { error: 'postgres.database is required.' }
  }
  if (!username) {
    return { error: 'postgres.username is required.' }
  }
  if (!password) {
    return { error: 'postgres.password is required.' }
  }

  const port =
    raw.port === undefined || raw.port === null
      ? '5432'
      : typeof raw.port === 'number'
        ? String(raw.port)
        : typeof raw.port === 'string'
          ? raw.port.trim()
          : ''

  if (!port) {
    return { error: 'postgres.port is required.' }
  }

  const ssl = typeof raw.ssl === 'string' && raw.ssl.trim() ? raw.ssl.trim() : 'preferred'

  return { host, port, database, username, password, ssl }
}

/**
 * Applies connection settings to every PostgreSQL block in workflow state.
 */
export function populatePostgresBlocks(
  workflowData: { blocks: Record<string, unknown> },
  connection: PostgresConnectionConfig
): number {
  let blocksUpdated = 0

  for (const block of Object.values(workflowData.blocks)) {
    if (!isRecord(block) || block.type !== POSTGRES_BLOCK_TYPE) {
      continue
    }

    if (!isRecord(block.subBlocks)) {
      block.subBlocks = {}
    }

    const subBlocks = block.subBlocks as Record<string, unknown>
    setSubBlockValue(subBlocks, 'host', connection.host)
    setSubBlockValue(subBlocks, 'port', connection.port)
    setSubBlockValue(subBlocks, 'database', connection.database)
    setSubBlockValue(subBlocks, 'username', connection.username)
    setSubBlockValue(subBlocks, 'password', connection.password)
    setSubBlockValue(subBlocks, 'ssl', connection.ssl)

    blocksUpdated += 1
  }

  return blocksUpdated
}
