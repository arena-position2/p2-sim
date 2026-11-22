/**
 * Local-Copilot-only layout rules for complex HTML. Kept here so Arena guidance
 * does not change shared mothership `DOCUMENT_FORMAT_GUIDANCE`.
 */
export const LOCAL_COMPLEX_HTML_GUIDANCE = `Complex / Arena / Figma-export HTML (Local Copilot — CRITICAL):
- Models cannot one-shot recreate ~100KB+ pages with huge inline SVG path dumps.
- create_file a lean shell under ~100KB (semantic HTML + small CSS + tiny SVG icons or an icon CDN) — never paste multi-hundred-KB path data (server rejects oversized HTML create_file bodies).
- Put larger CSS/JS in sibling files (files/theme.css, files/app.js) and link them; grow with workspace_file append + edit_content in sections if needed.
- Prefer lucide/heroicons CDN or short <svg viewBox> symbols over exported path dumps.
- When the user uploads a complex HTML file: materialize_file (or keep files/ path), then grep + patch only — never create_file a full rewrite and never dump the source in chat.
- "Improve / redesign / enhance this HTML" first call: \`read\` Active documents \`preferredPath\` or \`files/<name>/content\` at offset 0 (or \`grep\`) — NOT \`list_file_folders\`, NOT \`uploads/\` with a high offset, NOT \`function_execute\` for inspection. If \`uploads/\` returns not found, next call \`glob("files/**<name>*")\` or use \`preferredPath\` — never re-probe uploads/.
- After materialize (or when the file is already under files/): only use \`files/…\` paths. Never retry \`uploads/\`. Prefer Active documents / preferredPath / workspaceFiles over inventing uploads/. Rematerialize of an already-promoted file returns "already at files/…" — use that path; do not treat it as failure.
- Whole-UI improve/redesign routing (CRITICAL): for lean HTML under ~40KB prefer \`materialize\` (if needed) → \`read files/…/content\` → ONE lean \`workspace_file\` \`operation=update\` with the improved page. Do NOT open the HTML in \`function_execute\` / Python just to print lines — that wastes the turn. Use \`read\`/\`grep\` for inspection. Many fragile CSS \`search_replace\` patches are worse than one lean update when the user asked to redesign the whole UI.
- Existing HTML ≥ ~40KB: NEVER workspace_file operation=update (full replace is blocked). Use operation=patch with search_replace only. Small lean HTML (<40KB) may use update when the user asked to rebuild/improve/redesign.
- Patch discipline: \`search\` MUST be copied from the latest live \`read\`/\`grep\` (or live excerpt on a prior miss) — never from a redesigned CSS/HTML draft that exists only in Thinking. Max 600 chars; short unique substring.
- HTML edit follow-ups ("apply point 3", "make the CTA stronger"): grep first with tokens from the user message / prior suggestion labels, then one patch within a few inspections — do not start with many offset/limit reads. Pure "give UX suggestions" turns may read without writing.
- If the ask is "make something like this uploaded page", recreate the layout/theme as a lean modular page — do not try to clone every SVG path.
- Always \`read\` \`files/<name>.html/content\` (bytes). Bare \`files/<name>.html\` is metadata only — do not page it with large offsets.
- Merge / fill missing section data (e.g. KPI rows into a dashboard shell): materialize the source if needed, grep once for the insert anchor (\`data-cis\`, empty tbody, placeholder), then ONE \`workspace_file\` + \`edit_content\` with the seed markup/JS. Do not reassemble the standalone via many overlapping offset/limit reads before writing. If a shell view already exists and the table is empty, patch into that shell — do not rematerialize the whole destination.
- Reads may truncate mega SVG/CSS lines — that is expected; use offset/limit or grep, then workspace_file patch.`
