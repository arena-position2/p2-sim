/**
 * Loop limits for the Arena Copilot agent turn.
 *
 * These live outside the orchestrator because the system prompt states several
 * of them to the model verbatim — keeping one definition stops the prompt and
 * the enforcing code from drifting apart.
 */

/** Forced follow-up rounds before the turn stops chasing mandatory follow-ups. */
export const MAX_FORCED_FOLLOW_UP_ROUNDS = 6

/** Cap for "I am applying…" prose with no tool call — avoid infinite nudge loops. */
export const MAX_INTENT_CONTINUATION_ROUNDS = 5

/**
 * After query_logs / get_execution_logs / explain_error, force at most one more
 * model round so the turn does not settle on tool rows with an empty bubble.
 */
export const MAX_DEBUG_EXPLANATION_CONTINUATION_ROUNDS = 1

/**
 * After get_available_blocks / get_blocks_metadata without create/edit, force
 * more model rounds so the turn does not settle on discovery tool rows alone.
 */
export const MAX_WORKFLOW_BUILD_CONTINUATION_ROUNDS = 2

/**
 * After read / grep / load_copilot_artifact without a file write, force more
 * rounds so HTML merge/fill fixes do not settle on tool rows + empty "Thinking…"
 * after a single nudge (models often keep paging the source instead of writing).
 */
export const MAX_FILE_EDIT_CONTINUATION_ROUNDS = 3

/**
 * When research/factual intent ends with no live web search tool call, force
 * one more round so Claude/Gemini cannot settle on a memory-only answer.
 */
export const MAX_RESEARCH_SEARCH_CONTINUATION_ROUNDS = 1

/**
 * Successful create-then-edit_workflow calls before the soft post-build nudge.
 * Complex agents (multi-capability graphs) often need more than a handful of
 * sequential edits — the soft nudge asks the model to wrap up without stripping
 * tools yet.
 */
export const MAX_POPULATE_EDITS = 16

/**
 * Absolute ceiling on successful populate edits this turn. Past this, tools are
 * restricted to final_only / oauth_only so the turn cannot thrash forever.
 */
export const MAX_POPULATE_EDITS_HARD_LOCK = 20

/**
 * Extra model rounds after create_workflow when populate somehow never queued —
 * keeps the turn from settling on an empty shell.
 */
export const MAX_INCOMPLETE_WORKFLOW_POPULATE_CONTINUATION_ROUNDS = 2

/**
 * `get_blocks_metadata` / `load_copilot_artifact` calls allowed after
 * create_workflow and before the first successful populate edit. Further
 * discovery calls are rejected so the model must edit_workflow.
 */
export const MAX_PRE_POPULATE_DISCOVERY_CALLS = 2

/**
 * Discovery-only rounds refunded against `MAX_TOOL_ITERATIONS` before the first
 * successful populate edit. Rejected discovery rounds are not refunded.
 */
export const MAX_PRE_POPULATE_DISCOVERY_ROUND_REFUNDS = 2
