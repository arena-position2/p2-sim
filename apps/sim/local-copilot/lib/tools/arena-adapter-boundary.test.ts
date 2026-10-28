/**
 * @vitest-environment node
 *
 * Level B Arena adapter boundary — CI/registry invariant.
 *
 * Pins: single Arena→server alias map, dual router keys for file/KB/search
 * leaf names, non-empty runtime schemas, and no empty-schema fallthrough for
 * `create_file` (the failure mode that produced "Tool not found" loops).
 */
import { describe, expect, it } from 'vitest'
import { TOOL_RUNTIME_SCHEMAS } from '@/lib/mothership/generated/tool-schemas-v1'
import {
  ARENA_ALIASED_SERVER_TOOL_NAMES,
  ARENA_DUAL_REGISTERED_SERVER_TOOL_NAMES,
  ARENA_FILE_PIPELINE_TOOL_NAMES,
  ARENA_SERVER_TOOL_SCHEMA_ALIASES,
  ARENA_TO_SERVER_REGISTRY_TOOL_NAME,
  toServerRegistryToolName,
} from '@/lib/mothership/tools/arena-server-tool-aliases'
import { getRegisteredServerToolNames } from '@/lib/mothership/tools/server/router'
import { buildMothershipDelegatedToolDefinitions } from '@/local-copilot/lib/tools/mothership-delegated-tool-defs'

function schemaPropertyCount(schemaId: string): number {
  const schema = TOOL_RUNTIME_SCHEMAS[schemaId]
  const parameters = schema?.parameters as { properties?: Record<string, unknown> } | undefined
  return parameters?.properties ? Object.keys(parameters.properties).length : 0
}

describe('Level B Arena adapter boundary', () => {
  it('keeps dual-registered Arena leaf names on the server router', () => {
    const registered = new Set(getRegisteredServerToolNames())

    for (const arenaName of ARENA_DUAL_REGISTERED_SERVER_TOOL_NAMES) {
      const serverName = ARENA_TO_SERVER_REGISTRY_TOOL_NAME[arenaName]
      expect(registered.has(arenaName), `${arenaName} must be dual-registered`).toBe(true)
      expect(registered.has(serverName), `${serverName} must remain registered`).toBe(true)
      expect(ARENA_SERVER_TOOL_SCHEMA_ALIASES[arenaName]).toBe(serverName)
    }
  })

  it('never leaves create_file / workspace_file / edit_content off the registry', () => {
    const registered = new Set(getRegisteredServerToolNames())
    for (const name of ARENA_FILE_PIPELINE_TOOL_NAMES) {
      expect(registered.has(name)).toBe(true)
      expect(registered.has(toServerRegistryToolName(name))).toBe(true)
    }
  })

  it('resolves a non-empty runtime schema for every aliased Arena tool', () => {
    for (const arenaName of ARENA_ALIASED_SERVER_TOOL_NAMES) {
      const schemaId = toServerRegistryToolName(arenaName)
      expect(
        schemaPropertyCount(schemaId),
        `${arenaName} → ${schemaId} must have schema properties`
      ).toBeGreaterThan(0)
    }
  })

  it('exposes non-empty LLM parameters for create_file in mothership defs', () => {
    const defs = buildMothershipDelegatedToolDefinitions()
    const createFile = defs.find((def) => def.name === 'create_file')
    expect(createFile).toBeDefined()
    const properties = (createFile?.parameters as { properties?: Record<string, unknown> })
      ?.properties
    expect(properties).toBeDefined()
    expect(Object.keys(properties ?? {}).length).toBeGreaterThan(0)
    expect(properties).toHaveProperty('fileName')
  })

  it('exposes save_upload schema properties on materialize_file for the LLM', () => {
    const defs = buildMothershipDelegatedToolDefinitions()
    const materialize = defs.find((def) => def.name === 'materialize_file')
    expect(materialize).toBeDefined()
    const properties = (materialize?.parameters as { properties?: Record<string, unknown> })
      ?.properties
    expect(properties).toBeDefined()
    expect(Object.keys(properties ?? {}).length).toBeGreaterThan(0)
    expect(properties).toHaveProperty('fileNames')
    expect(toServerRegistryToolName('materialize_file')).toBe('save_upload')
    expect(schemaPropertyCount('save_upload')).toBeGreaterThan(0)
  })

  it('does not dual-register function_execute as a server tool (run_function path)', () => {
    const registered = new Set(getRegisteredServerToolNames())
    expect(registered.has('function_execute')).toBe(false)
    expect(toServerRegistryToolName('function_execute')).toBe('run_function')
    expect(schemaPropertyCount('run_function')).toBeGreaterThan(0)
  })

  it('does not dual-register materialize_file as a server tool (save_upload path)', () => {
    const registered = new Set(getRegisteredServerToolNames())
    expect(registered.has('materialize_file')).toBe(false)
    expect(toServerRegistryToolName('materialize_file')).toBe('save_upload')
  })
})
