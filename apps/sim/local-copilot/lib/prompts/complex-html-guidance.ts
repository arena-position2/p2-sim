/**
 * Local-Copilot-only layout rules for complex HTML. Kept here so Arena guidance
 * does not change shared mothership `DOCUMENT_FORMAT_GUIDANCE`.
 */
export const LOCAL_COMPLEX_HTML_GUIDANCE = `Complex / Arena / Figma-export HTML (Local Copilot — CRITICAL):
- Models cannot one-shot recreate ~100KB+ pages with huge inline SVG path dumps.
- create_file a lean shell (semantic HTML + small CSS + tiny SVG icons or an icon CDN) — never paste multi-hundred-KB path data.
- Put larger CSS/JS in sibling files (files/theme.css, files/app.js) and link them; grow with workspace_file append + edit_content in sections if needed.
- Prefer lucide/heroicons CDN or short <svg viewBox> symbols over exported path dumps.
- When the user uploads a complex HTML file: materialize_file (or keep files/ path), then grep + patch only — never create_file a full rewrite and never dump the source in chat.
- If the ask is "make something like this uploaded page", recreate the layout/theme as a lean modular page — do not try to clone every SVG path.
- Always \`read\` \`files/<name>.html/content\` (bytes). Bare \`files/<name>.html\` is metadata only — do not page it with large offsets.
- Merge / fill missing section data (e.g. KPI rows into a dashboard shell): materialize the source if needed, grep once for the insert anchor (\`data-cis\`, empty tbody, placeholder), then ONE \`workspace_file\` + \`edit_content\` with the seed markup/JS. Do not reassemble the standalone via many overlapping offset/limit reads before writing. If a shell view already exists and the table is empty, patch into that shell — do not rematerialize the whole destination.
- Reads may truncate mega SVG/CSS lines — that is expected; use offset/limit or grep, then workspace_file patch.`
