/**
 * Layout rules for workspace markdown and office files.
 * Sandbox bootstraps already inject geometry globals; models must be told to use them
 * or they dump one unstyled text box / wall of prose.
 */
export const DOCUMENT_FORMAT_GUIDANCE = `Document layout (CRITICAL — never ship an unstyled dump):

Markdown (.md) — write finished GitHub-flavored markdown in create_file \`content\` (or edit_content):
- Start with a single \`# Title\`, then \`##\` / \`###\` sections. Blank line between blocks.
- Use lists, tables, and **bold** for key terms. Fenced code only for actual code — never wrap the whole file in a fence.
- Do not emit \`<options>\`, tool names, or HTML chrome. Keep paragraphs to 3–5 sentences.

HTML (.html) — create_file with the full page. When editing an existing HTML file:
- ALWAYS \`read\` \`files/<name>.html/content\` first. Never invent a new page from the filename or the user's one-line request.
- Targeted changes (title, heading, copy, one CSS rule): \`workspace_file\` operation=patch, strategy=search_replace, search=the exact current substring, then \`edit_content\` with ONLY the replacement. Do not regenerate the file.
- Full rewrite only when the user asked to rebuild the page — then \`edit_content\` must start from the read result.

PPTX — 16:9 globals already exist: SLIDE_W=10, SLIDE_H=5.625, MARGIN=0.5, CONTENT_W=9, CONTENT_H=3.8 (inches). Never require/import.
- Title slide: accent bar + large title (28–32pt) + subtitle. Content slides: title at y=MARGIN (22–26pt bold), body at y=1.15 with bullets (14–18pt), valign top.
- One idea per slide. 4–7 bullets max. Do not put the whole deck in one addText box.
- Keep boxes inside the margin: x>=MARGIN, y>=MARGIN, x+w<=SLIDE_W-MARGIN, y+h<=SLIDE_H-MARGIN.
- Palette: titles #1B365D, body #333333, accent #2E6DA4, light fill #F4F7FB. fontFace Arial (or Calibri).
- Example:
  const s = pptx.addSlide();
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: SLIDE_W, h: 0.1, fill: { color: "1B365D" } });
  s.addText("Section title", { x: MARGIN, y: MARGIN, w: CONTENT_W, h: 0.5, fontSize: 24, fontFace: "Arial", bold: true, color: "1B365D" });
  s.addText([{ text: "First point", options: { bullet: true } }, { text: "Second point", options: { bullet: true } }], { x: MARGIN, y: 1.2, w: CONTENT_W, h: CONTENT_H, fontSize: 16, fontFace: "Arial", color: "333333", valign: "top" });

DOCX — twip globals: PAGE_W, PAGE_H, MARGIN, CONTENT_W. Prefer addSection (never docx.addSection). Never require('docx').
- Set styles once: globalThis.__docxDocOptions = { styles: { default: { document: { run: { font: "Calibri", size: 22 } } } } };
- Use HeadingLevel.HEADING_1 / HEADING_2, then body Paragraphs with spacing.after. Lists via numbering — not a single TextRun for the whole memo.
- Page margins via section properties using MARGIN. size is half-points (22 = 11pt, 32 = 16pt).
- Example:
  addSection({
    properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } } },
    children: [
      new docx.Paragraph({ heading: docx.HeadingLevel.HEADING_1, children: [new docx.TextRun("Title")] }),
      new docx.Paragraph({ spacing: { after: 200 }, children: [new docx.TextRun({ text: "Lead paragraph.", size: 22 })] }),
    ],
  });

PDF — globals: pdf, rgb, StandardFonts, LETTER=[612,792]. Add pages with pdf.addPage(LETTER). 54pt margins, Helvetica-Bold titles, wrap body text — never one drawText line for a paragraph.`

const PLAIN_TEXT_WORKSPACE_FILE_EXT = /\.(html|htm|md|markdown|txt|json|csv)$/i

/**
 * True for workspace files whose body is stored as UTF-8 text (not compiled office docs).
 */
export function isPlainTextWorkspaceFileName(fileName: string): boolean {
  const leaf =
    fileName
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/content$/i, '')
      .split('/')
      .pop() ?? ''
  return PLAIN_TEXT_WORKSPACE_FILE_EXT.test(leaf)
}

/**
 * Short reminder injected on workspace_file success so the next edit_content
 * call is laid out, not a hello-world probe.
 */
export function documentLayoutFollowUpHint(fileName: string, baseHint: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.pptx')) {
    return `${baseHint} Use SLIDE_W/MARGIN/CONTENT_W/CONTENT_H. Title row + bullets, one idea per slide, stay inside margins. Not a single full-slide text box.`
  }
  if (lower.endsWith('.docx')) {
    return `${baseHint} Set __docxDocOptions, HeadingLevel headings, spaced Paragraphs, addSection with PAGE_W/MARGIN. Not one unstyled TextRun.`
  }
  if (lower.endsWith('.pdf')) {
    return `${baseHint} Use LETTER pages, 54pt margins, Helvetica-Bold titles, wrapped body. Not a single drawText line.`
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return `${baseHint} Write finished GFM: # title, ## sections, lists/tables, blank lines. Do not wrap the whole file in a code fence.`
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return `${baseHint} Preserve the existing HTML. For a title/heading/string change use operation=patch with search_replace and the exact current substring — do not regenerate the page. If using update, edit_content must start from the current file.`
  }
  return baseHint
}
