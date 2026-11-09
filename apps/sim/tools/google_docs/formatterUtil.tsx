interface LinkRange {
  start: number
  end: number
  url: string
}

interface FormatRange {
  start: number
  end: number
  type: 'bold' | 'italic' | 'strikethrough' | 'code'
}

interface TableData {
  headers: string[]
  rows: string[][]
  endIndex: number
}

export function convertMarkdownToGoogleDocsRequests(
  markdown: string,
  title?: string,
  startIndex?: number
): Array<Record<string, any>> {
  const requests: Array<Record<string, any>> = []
  let currentIndex = startIndex ?? 1

  // Only add initial newline if starting at the beginning
  if (!startIndex || startIndex === 1) {
    requests.push({
      insertText: {
        location: { index: currentIndex },
        text: '\n',
      },
    })
    currentIndex += 1
  }

  const lines = markdown.split('\n')

  // Add centered title if provided
  if (title && title.trim().length > 0) {
    currentIndex = addCenteredTitle(requests, title, currentIndex)
  }

  let i = 0
  let listItems: Array<{ text: string; indentLevel: number; type: 'bullet' | 'numbered' }> = []
  let listStartIndex: number | null = null

  const flushListItems = () => {
    if (listItems.length > 0 && listStartIndex !== null) {
      currentIndex = addListBlockRequests(requests, listItems, listStartIndex)
      listItems = []
      listStartIndex = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]
    const trimmedLine = line.trim()

    // Check for markdown tables
    if (trimmedLine.startsWith('|') && i + 1 < lines.length) {
      const tableResult = processMarkdownTable(lines, i)
      if (tableResult) {
        flushListItems()
        currentIndex = addTableRequest(requests, tableResult, currentIndex)
        i = tableResult.endIndex + 1
        continue
      }
    }

    // Check for code blocks
    if (line.startsWith('```')) {
      flushListItems()
      const codeBlockResult = processCodeBlock(lines, i)
      currentIndex = addCodeBlockRequest(
        requests,
        codeBlockResult.code,
        codeBlockResult.language,
        currentIndex
      )
      i = codeBlockResult.endIndex + 1
      continue
    }

    // Check for blockquotes
    if (line.startsWith('> ')) {
      flushListItems()

      // Collect all consecutive blockquote lines
      const blockquoteLines: string[] = []
      let j = i
      while (j < lines.length && lines[j].startsWith('> ')) {
        // Remove the '> ' prefix
        blockquoteLines.push(lines[j].substring(2))
        j++
      }

      // Check if this is an alert-style blockquote (e.g., [!NOTE], [!TIP], etc.)
      let alertType: string | null = null
      let alertColor: { red: number; green: number; blue: number } = {
        red: 0.8,
        green: 0.8,
        blue: 0.8,
      }

      if (blockquoteLines.length > 0) {
        const firstLine = blockquoteLines[0].trim()
        const alertMatch = firstLine.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i)
        if (alertMatch) {
          alertType = alertMatch[1].toUpperCase()
          // Remove the alert marker line
          blockquoteLines.shift()

          // Set color based on alert type
          switch (alertType) {
            case 'NOTE':
              alertColor = { red: 0.53, green: 0.81, blue: 0.92 } // Light blue
              break
            case 'TIP':
              alertColor = { red: 0.56, green: 0.93, blue: 0.56 } // Light green
              break
            case 'IMPORTANT':
              alertColor = { red: 0.68, green: 0.51, blue: 0.87 } // Light purple
              break
            case 'WARNING':
              alertColor = { red: 1.0, green: 0.8, blue: 0.4 } // Light orange/yellow
              break
            case 'CAUTION':
              alertColor = { red: 1.0, green: 0.4, blue: 0.4 } // Light red
              break
          }
        }
      }

      // Process the blockquote content as markdown
      const blockquoteMarkdown = blockquoteLines.join('\n')
      const blockquoteStartIndex = currentIndex

      // Process blockquote content recursively - but we need to simulate execution
      // to track the actual end index after tabs are consumed by createParagraphBullets
      const tempRequests: Array<Record<string, any>> = []
      let tempIndex = currentIndex

      // Add initial newline if starting at beginning
      if (currentIndex === 1) {
        tempRequests.push({
          insertText: {
            location: { index: tempIndex },
            text: '\n',
          },
        })
        tempIndex += 1
      }

      // Process the blockquote markdown line by line
      const blockquoteInnerLines = blockquoteMarkdown.split('\n')
      let blockListItems: Array<{
        text: string
        indentLevel: number
        type: 'bullet' | 'numbered'
      }> = []
      let blockListStartIndex: number | null = null

      const flushBlockListItems = () => {
        if (blockListItems.length > 0 && blockListStartIndex !== null) {
          tempIndex = addListBlockRequests(tempRequests, blockListItems, blockListStartIndex)
          blockListItems = []
          blockListStartIndex = null
        }
      }

      for (let k = 0; k < blockquoteInnerLines.length; k++) {
        const blockLine = blockquoteInnerLines[k]
        const blockTrimmed = blockLine.trim()

        if (blockTrimmed.length === 0) {
          flushBlockListItems()
          tempRequests.push({
            insertText: {
              location: { index: tempIndex },
              text: '\n',
            },
          })
          tempRequests.push({
            updateParagraphStyle: {
              range: {
                startIndex: tempIndex,
                endIndex: tempIndex + 1,
              },
              paragraphStyle: {
                namedStyleType: 'NORMAL_TEXT',
              },
              fields: 'namedStyleType',
            },
          })
          tempIndex += 1
          continue
        }

        // Check for code blocks
        if (blockTrimmed.startsWith('```')) {
          flushBlockListItems()
          const codeBlockResult = processCodeBlock(blockquoteInnerLines, k)
          tempIndex = addCodeBlockRequest(
            tempRequests,
            codeBlockResult.code,
            codeBlockResult.language,
            tempIndex
          )
          k = codeBlockResult.endIndex
          continue
        }

        // Check for bullet lists
        const bulletMatch = blockTrimmed.match(/^[-*+]\s+(.*)/)
        if (bulletMatch) {
          const text = bulletMatch[1]
          const leadingSpaces = blockLine.length - blockLine.trimStart().length
          const indentLevel = Math.floor(leadingSpaces / 2)

          if (blockListItems.length > 0 && blockListItems[0].type !== 'bullet') {
            flushBlockListItems()
          }

          if (blockListStartIndex === null) {
            blockListStartIndex = tempIndex
          }

          blockListItems.push({ text, indentLevel, type: 'bullet' })
          continue
        }

        // Check for numbered lists
        const numberedMatch = blockTrimmed.match(/^(\d+)\.\s+(.*)/)
        if (numberedMatch) {
          const text = numberedMatch[2]
          const leadingSpaces = blockLine.length - blockLine.trimStart().length
          const indentLevel = Math.floor(leadingSpaces / 2)

          if (blockListItems.length > 0 && blockListItems[0].type !== 'numbered') {
            flushBlockListItems()
          }

          if (blockListStartIndex === null) {
            blockListStartIndex = tempIndex
          }

          blockListItems.push({ text, indentLevel, type: 'numbered' })
          continue
        }

        // Regular paragraph
        flushBlockListItems()
        tempIndex = addParagraphWithFormattingRequest(tempRequests, blockLine, tempIndex)
      }

      flushBlockListItems()
      const blockquoteEndIndex = tempIndex

      // If this is an alert-style blockquote, add the label at the beginning
      if (alertType) {
        // Insert alert label before the blockquote content
        requests.push({
          insertText: {
            location: { index: blockquoteStartIndex },
            text: `${alertType}\n`,
          },
        })

        // Make the label bold
        requests.push({
          updateTextStyle: {
            range: {
              startIndex: blockquoteStartIndex,
              endIndex: blockquoteStartIndex + alertType.length,
            },
            textStyle: {
              bold: true,
              foregroundColor: {
                color: {
                  rgbColor: alertColor,
                },
              },
            },
            fields: 'bold,foregroundColor',
          },
        })

        // Adjust all subsequent requests to account for the label
        const labelLength = alertType.length + 1
        for (const request of tempRequests) {
          if (request.insertText?.location?.index !== undefined) {
            request.insertText.location.index += labelLength
          }
          if (request.updateTextStyle?.range) {
            request.updateTextStyle.range.startIndex += labelLength
            request.updateTextStyle.range.endIndex += labelLength
          }
          if (request.updateParagraphStyle?.range) {
            request.updateParagraphStyle.range.startIndex += labelLength
            request.updateParagraphStyle.range.endIndex += labelLength
          }
          if (request.createParagraphBullets?.range) {
            request.createParagraphBullets.range.startIndex += labelLength
            request.createParagraphBullets.range.endIndex += labelLength
          }
        }
      }

      // Add all blockquote requests
      requests.push(...tempRequests)

      // Calculate final end index
      const finalEndIndex = alertType
        ? blockquoteEndIndex + alertType.length + 1
        : blockquoteEndIndex

      // Apply blockquote styling to the entire range
      requests.push({
        updateParagraphStyle: {
          range: {
            startIndex: blockquoteStartIndex,
            endIndex: finalEndIndex,
          },
          paragraphStyle: {
            indentStart: { magnitude: 36, unit: 'PT' },
            borderLeft: {
              color: { color: { rgbColor: alertColor } },
              width: { magnitude: 3, unit: 'PT' },
              padding: { magnitude: 8, unit: 'PT' },
              dashStyle: 'SOLID',
            },
          },
          fields: 'indentStart,borderLeft',
        },
      })

      currentIndex = finalEndIndex
      i = j
      continue
    }

    // Check for horizontal rules
    if (trimmedLine === '---' || trimmedLine === '***' || trimmedLine === '___') {
      flushListItems()
      currentIndex = addHorizontalRuleRequest(requests, currentIndex)
      i++
      continue
    }

    // Check for headings
    if (line.startsWith('#### ')) {
      flushListItems()
      currentIndex = addHeadingRequest(requests, line.substring(5), currentIndex, 'HEADING_4')
      i++
      continue
    }
    if (line.startsWith('### ')) {
      flushListItems()
      currentIndex = addHeadingRequest(requests, line.substring(4), currentIndex, 'HEADING_3')
      i++
      continue
    }
    if (line.startsWith('## ')) {
      flushListItems()
      currentIndex = addHeadingRequest(requests, line.substring(3), currentIndex, 'HEADING_2')
      i++
      continue
    }
    if (line.startsWith('# ')) {
      flushListItems()
      currentIndex = addHeadingRequest(requests, line.substring(2), currentIndex, 'HEADING_1')
      i++
      continue
    }

    // Check for task lists
    if (
      trimmedLine.startsWith('- [ ]') ||
      trimmedLine.startsWith('- [x]') ||
      trimmedLine.startsWith('- [X]')
    ) {
      flushListItems()
      const checked = trimmedLine.startsWith('- [x]') || trimmedLine.startsWith('- [X]')
      const taskText = trimmedLine.substring(5).trim()
      currentIndex = addTaskListRequest(requests, taskText, checked, currentIndex)
      i++
      continue
    }

    // Check for ordered lists (numbered)
    const numberedMatch = trimmedLine.match(/^(\d+)\.\s+(.*)/)
    if (numberedMatch) {
      const text = numberedMatch[2]
      const leadingSpaces = line.length - line.trimStart().length
      const indentLevel = Math.floor(leadingSpaces / 2)

      // Start new list block if this is a different type
      if (listItems.length > 0 && listItems[0].type !== 'numbered') {
        flushListItems()
      }

      if (listStartIndex === null) {
        listStartIndex = currentIndex
      }

      listItems.push({ text, indentLevel, type: 'numbered' })
      i++
      continue
    }

    // Check for bullet points (unordered lists)
    const bulletMatch = trimmedLine.match(/^[-*+]\s+(.*)/)
    if (bulletMatch) {
      const text = bulletMatch[1]
      const leadingSpaces = line.length - line.trimStart().length
      const indentLevel = Math.floor(leadingSpaces / 2)

      // Start new list block if this is a different type
      if (listItems.length > 0 && listItems[0].type !== 'bullet') {
        flushListItems()
      }

      if (listStartIndex === null) {
        listStartIndex = currentIndex
      }

      listItems.push({ text, indentLevel, type: 'bullet' })
      i++
      continue
    }

    // Empty line - breaks list blocks
    if (trimmedLine.length === 0) {
      flushListItems()
      currentIndex = addEmptyLineRequest(requests, currentIndex)
      i++
      continue
    }

    // Regular paragraph
    flushListItems()
    currentIndex = addParagraphWithFormattingRequest(requests, line, currentIndex)
    i++
  }

  // Flush any remaining list items
  flushListItems()
  return requests
}

function processCodeBlock(
  lines: string[],
  startIndex: number
): { code: string; language: string; endIndex: number } {
  const firstLine = lines[startIndex].trim()
  const language = firstLine.substring(3).trim() || 'plain'
  const codeLines: string[] = []
  let i = startIndex + 1

  while (i < lines.length && !lines[i].trim().startsWith('```')) {
    codeLines.push(lines[i])
    i++
  }

  return {
    code: codeLines.join('\n'),
    language,
    endIndex: i,
  }
}

function processMarkdownTable(lines: string[], startIndex: number): TableData | null {
  const firstLine = lines[startIndex].trim()
  if (!firstLine.startsWith('|') || !firstLine.endsWith('|')) {
    return null
  }

  if (startIndex + 1 >= lines.length) {
    return null
  }

  const separatorLine = lines[startIndex + 1].trim()
  if (!/^\|(?:\s*:?-+:?\s*\|)+$/.test(separatorLine)) {
    return null
  }

  const tableLines: string[] = [firstLine, separatorLine]
  let i = startIndex + 2

  while (i < lines.length) {
    const line = lines[i].trim()
    if (!line.startsWith('|') || !line.endsWith('|')) {
      break
    }
    tableLines.push(line)
    i++
  }

  const formattedTable = formatTableWithSpacing(tableLines)

  return {
    headers: [],
    rows: [[formattedTable]],
    endIndex: i - 1,
  }
}

function formatTableWithSpacing(tableLines: string[]): string {
  // Parse all rows to find column widths
  const allRows = tableLines.map((line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
  )

  // Calculate max width for each column
  const numCols = allRows[0].length
  const colWidths: number[] = []

  for (let col = 0; col < numCols; col++) {
    let maxWidth = 0
    for (const row of allRows) {
      if (col < row.length) {
        // Skip separator row (contains only dashes, colons, and spaces)
        if (!/^:?-+:?$/.test(row[col])) {
          maxWidth = Math.max(maxWidth, row[col].length)
        }
      }
    }
    colWidths.push(maxWidth)
  }

  // Calculate maximum line width (80 characters to prevent wrapping in Google Docs)
  const MAX_LINE_WIDTH = 80
  const PIPE_PADDING = 3 // ' | ' between columns
  const BORDER_CHARS = 4 // '| ' at start and ' |' at end
  const ROW_COL_WIDTH = 8 // Width for "Row" column in continuation segments (includes padding)

  // Determine column segments that fit within MAX_LINE_WIDTH
  const segments: number[][] = []
  let currentSegment: number[] = []
  let currentWidth = BORDER_CHARS // Start with '| ' and ' |'

  for (let col = 0; col < numCols; col++) {
    const colWidth = colWidths[col]
    const additionalWidth = colWidth + (currentSegment.length > 0 ? PIPE_PADDING : 0)

    // For non-first segments, account for the "Row" column
    const isFirstSegment = segments.length === 0 && currentSegment.length === 0
    const extraWidth = isFirstSegment ? 0 : ROW_COL_WIDTH + PIPE_PADDING

    // Check if adding this column exceeds the limit
    if (currentWidth + additionalWidth + extraWidth > MAX_LINE_WIDTH && currentSegment.length > 0) {
      // Save current segment and start new one
      segments.push([...currentSegment])
      currentSegment = [col]
      currentWidth = BORDER_CHARS + colWidth + ROW_COL_WIDTH + PIPE_PADDING // Include row column for new segment
    } else {
      currentSegment.push(col)
      currentWidth += additionalWidth
    }
  }

  // Add the last segment
  if (currentSegment.length > 0) {
    segments.push(currentSegment)
  }

  // Format each segment vertically
  const allFormattedLines: string[] = []

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const segment = segments[segIdx]

    // Add segment header if not the first segment
    if (segIdx > 0) {
      allFormattedLines.push('') // Empty line between segments
      allFormattedLines.push('') // Another empty line for spacing
      const colStart = segment[0] + 1
      const colEnd = segment[segment.length - 1] + 1
      allFormattedLines.push(`Columns ${colStart}-${colEnd}:`)
    }

    // For continuation segments, add a "Row" identifier column
    const needsRowColumn = segIdx > 0
    const rowColWidth = needsRowColumn ? 5 : 0 // Width for "Row" text

    // Format each row in this segment
    for (let rowIdx = 0; rowIdx < allRows.length; rowIdx++) {
      const row = allRows[rowIdx]
      const cells: string[] = []

      // Add row identifier for continuation segments
      if (needsRowColumn) {
        if (rowIdx === 0) {
          // Header row
          cells.push('Row'.padEnd(rowColWidth, ' '))
        } else if (rowIdx === 1) {
          // Separator row
          cells.push('-'.repeat(rowColWidth))
        } else {
          // Data rows - show row number
          cells.push(`${rowIdx - 1}`.padEnd(rowColWidth, ' '))
        }
      }

      for (const col of segment) {
        const cellContent = col < row.length ? row[col] : ''
        const width = colWidths[col]

        // Check if this is the separator row
        if (/^:?-+:?$/.test(cellContent)) {
          // Create separator with proper alignment indicators
          let separator = ''
          if (cellContent.startsWith(':') && cellContent.endsWith(':')) {
            // Center aligned
            separator = `:${'-'.repeat(Math.max(0, width - 2))}:`
          } else if (cellContent.endsWith(':')) {
            // Right aligned
            separator = `${'-'.repeat(Math.max(0, width - 1))}:`
          } else if (cellContent.startsWith(':')) {
            // Left aligned
            separator = `:${'-'.repeat(Math.max(0, width - 1))}`
          } else {
            // Default (left aligned)
            separator = '-'.repeat(width)
          }
          cells.push(separator)
        } else {
          // Regular cell - pad to column width
          cells.push(cellContent.padEnd(width, ' '))
        }
      }

      // Join cells with proper spacing
      allFormattedLines.push(`| ${cells.join(' | ')} |`)
    }
  }

  return allFormattedLines.join('\n')
}

function addHorizontalRuleRequest(requests: Array<Record<string, any>>, index: number): number {
  // Insert a newline for the border to apply to
  requests.push({
    insertText: {
      location: { index },
      text: '\n',
    },
  })

  // Apply paragraph border with dashed style
  requests.push({
    updateParagraphStyle: {
      range: {
        startIndex: index,
        endIndex: index + 1,
      },
      paragraphStyle: {
        borderBottom: {
          color: {
            color: {
              rgbColor: {
                red: 0.5,
                green: 0.5,
                blue: 0.5,
              },
            },
          },
          width: {
            magnitude: 1,
            unit: 'PT',
          },
          padding: {
            magnitude: 0,
            unit: 'PT',
          },
          dashStyle: 'DASH',
        },
      },
      fields: 'borderBottom',
    },
  })

  return index + 1
}

function addListBlockRequests(
  requests: Array<Record<string, any>>,
  listItems: Array<{ text: string; indentLevel: number; type: 'bullet' | 'numbered' }>,
  startIndex: number
): number {
  if (listItems.length === 0) return startIndex

  const listType = listItems[0].type
  let currentIndex = startIndex
  let totalTabs = 0
  const allFormatRequests: Array<{ range: FormatRange; index: number }> = []
  const allLinkRequests: Array<{ range: LinkRange; index: number }> = []

  // First, insert all the text for all list items
  for (const item of listItems) {
    const cleanTextBuilder: string[] = []
    const formatRanges: FormatRange[] = []
    const linkRanges: LinkRange[] = []

    parseInlineFormatting(item.text, cleanTextBuilder, formatRanges, linkRanges)
    const cleanText = cleanTextBuilder.join('')

    // Add tab characters for nesting level
    const tabs = '\t'.repeat(item.indentLevel)
    const textWithTabs = tabs + cleanText
    totalTabs += item.indentLevel

    requests.push({
      insertText: {
        location: { index: currentIndex },
        text: `${textWithTabs}\n`,
      },
    })

    // Collect formatting requests with adjusted positions
    for (const range of formatRanges) {
      allFormatRequests.push({
        range: {
          ...range,
          start: range.start + item.indentLevel,
          end: range.end + item.indentLevel,
        },
        index: currentIndex,
      })
    }

    for (const range of linkRanges) {
      allLinkRequests.push({
        range: {
          ...range,
          start: range.start + item.indentLevel,
          end: range.end + item.indentLevel,
        },
        index: currentIndex,
      })
    }

    currentIndex += textWithTabs.length + 1
  }

  // Apply all formatting
  for (const { range, index } of allFormatRequests) {
    const formatStart = index + range.start
    const formatEnd = index + range.end

    if (range.type === 'bold') {
      requests.push({
        updateTextStyle: {
          range: { startIndex: formatStart, endIndex: formatEnd },
          textStyle: { bold: true },
          fields: 'bold',
        },
      })
    } else if (range.type === 'italic') {
      requests.push({
        updateTextStyle: {
          range: { startIndex: formatStart, endIndex: formatEnd },
          textStyle: { italic: true },
          fields: 'italic',
        },
      })
    } else if (range.type === 'strikethrough') {
      requests.push({
        updateTextStyle: {
          range: { startIndex: formatStart, endIndex: formatEnd },
          textStyle: { strikethrough: true },
          fields: 'strikethrough',
        },
      })
    } else if (range.type === 'code') {
      requests.push({
        updateTextStyle: {
          range: { startIndex: formatStart, endIndex: formatEnd },
          textStyle: {
            weightedFontFamily: { fontFamily: 'Courier New' },
            backgroundColor: { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } },
          },
          fields: 'weightedFontFamily,backgroundColor',
        },
      })
    }
  }

  for (const { range, index } of allLinkRequests) {
    const formatStart = index + range.start
    const formatEnd = index + range.end
    requests.push({
      updateTextStyle: {
        range: { startIndex: formatStart, endIndex: formatEnd },
        textStyle: { link: { url: range.url } },
        fields: 'link',
      },
    })
  }

  // Apply bullets to the entire range once
  const bulletPreset =
    listType === 'bullet' ? 'BULLET_DISC_CIRCLE_SQUARE' : 'NUMBERED_DECIMAL_ALPHA_ROMAN'

  requests.push({
    createParagraphBullets: {
      range: {
        startIndex: startIndex,
        endIndex: currentIndex,
      },
      bulletPreset,
    },
  })

  // After createParagraphBullets, tabs are consumed and the document is shorter
  // Return the adjusted index (subtract the number of tab characters)
  return currentIndex - totalTabs
}

function addTaskListRequest(
  requests: Array<Record<string, any>>,
  text: string,
  checked: boolean,
  index: number
): number {
  const prefix = checked ? '☑ ' : '☐ '
  const fullText = prefix + text

  requests.push({
    insertText: {
      location: { index },
      text: `${fullText}\n`,
    },
  })

  if (checked) {
    requests.push({
      updateTextStyle: {
        range: {
          startIndex: index + prefix.length,
          endIndex: index + fullText.length,
        },
        textStyle: { strikethrough: true },
        fields: 'strikethrough',
      },
    })
  }

  return index + fullText.length + 1
}

function addCenteredTitle(
  requests: Array<Record<string, any>>,
  title: string,
  index: number
): number {
  requests.push({
    insertText: {
      location: { index },
      text: `${title}\n\n`,
    },
  })

  requests.push({
    updateParagraphStyle: {
      range: {
        startIndex: index,
        endIndex: index + title.length + 1,
      },
      paragraphStyle: {
        namedStyleType: 'TITLE',
        alignment: 'CENTER',
      },
      fields: 'namedStyleType,alignment',
    },
  })

  return index + title.length + 2
}

function addHeadingRequest(
  requests: Array<Record<string, any>>,
  text: string,
  index: number,
  headingType: string
): number {
  const cleanTextBuilder: string[] = []
  const formatRanges: FormatRange[] = []
  const linkRanges: LinkRange[] = []

  parseInlineFormatting(text, cleanTextBuilder, formatRanges, linkRanges)
  const cleanText = cleanTextBuilder.join('')

  requests.push({
    insertText: {
      location: { index },
      text: `${cleanText}\n`,
    },
  })

  requests.push({
    updateParagraphStyle: {
      range: {
        startIndex: index,
        endIndex: index + cleanText.length + 1,
      },
      paragraphStyle: {
        namedStyleType: headingType,
      },
      fields: 'namedStyleType',
    },
  })

  // Apply inline formatting
  applyInlineFormatting(requests, formatRanges, linkRanges, index)

  return index + cleanText.length + 1
}

function addParagraphWithFormattingRequest(
  requests: Array<Record<string, any>>,
  line: string,
  startIndex: number
): number {
  const cleanTextBuilder: string[] = []
  const formatRanges: FormatRange[] = []
  const linkRanges: LinkRange[] = []

  parseInlineFormatting(line, cleanTextBuilder, formatRanges, linkRanges)
  const cleanText = cleanTextBuilder.join('')

  requests.push({
    insertText: {
      location: { index: startIndex },
      text: `${cleanText}\n`,
    },
  })

  applyInlineFormatting(requests, formatRanges, linkRanges, startIndex)

  return startIndex + cleanText.length + 1
}

function addEmptyLineRequest(requests: Array<Record<string, any>>, index: number): number {
  requests.push({
    insertText: {
      location: { index },
      text: '\n',
    },
  })

  // Apply default paragraph style to prevent UNIT_UNSPECIFIED errors
  requests.push({
    updateParagraphStyle: {
      range: {
        startIndex: index,
        endIndex: index + 1,
      },
      paragraphStyle: {
        namedStyleType: 'NORMAL_TEXT',
      },
      fields: 'namedStyleType',
    },
  })

  return index + 1
}

function addTableRequest(
  requests: Array<Record<string, any>>,
  tableData: TableData,
  index: number
): number {
  const formattedTable = tableData.rows[0][0]

  requests.push({
    insertText: {
      location: { index },
      text: `${formattedTable}\n`,
    },
  })

  requests.push({
    updateTextStyle: {
      range: {
        startIndex: index,
        endIndex: index + formattedTable.length,
      },
      textStyle: {
        weightedFontFamily: { fontFamily: 'Courier New' },
        fontSize: { magnitude: 10, unit: 'PT' },
        backgroundColor: { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } },
      },
      fields: 'weightedFontFamily,fontSize,backgroundColor',
    },
  })

  return index + formattedTable.length + 1
}

function parseInlineFormatting(
  text: string,
  cleanTextBuilder: string[],
  formatRanges: FormatRange[],
  linkRanges: LinkRange[]
): void {
  let i = 0

  while (i < text.length) {
    // Check for links [text](url)
    const linkMatch = text.substring(i).match(/^\[([^\]]+)\]\(([^)]+)\)/)
    if (linkMatch) {
      const linkText = linkMatch[1]
      const linkUrl = linkMatch[2]
      const linkStart = cleanTextBuilder.join('').length

      // Parse formatting inside the link text
      const nestedCleanText: string[] = []
      const nestedFormatRanges: FormatRange[] = []
      const nestedLinkRanges: LinkRange[] = []
      parseInlineFormattingWithoutLinks(
        linkText,
        nestedCleanText,
        nestedFormatRanges,
        nestedLinkRanges
      )

      const cleanLinkText = nestedCleanText.join('')
      cleanTextBuilder.push(cleanLinkText)
      const linkEnd = cleanTextBuilder.join('').length

      // Add the link range
      linkRanges.push({ start: linkStart, end: linkEnd, url: linkUrl })

      // Add formatting ranges from within the link text, adjusted for position
      for (const range of nestedFormatRanges) {
        formatRanges.push({
          start: linkStart + range.start,
          end: linkStart + range.end,
          type: range.type,
        })
      }

      i += linkMatch[0].length
      continue
    }

    // Check for inline code `code`
    // Skip if this is a code block delimiter (```)
    if (text[i] === '`' && !text.substring(i).startsWith('```')) {
      const codeStart = cleanTextBuilder.join('').length
      i++
      const codeChars: string[] = []
      while (i < text.length && text[i] !== '`') {
        codeChars.push(text[i])
        i++
      }
      if (i < text.length) {
        const codeContent = codeChars.join('')
        // Only apply code formatting if there's actual content
        if (codeContent.length > 0) {
          cleanTextBuilder.push(codeContent)
          const codeEnd = cleanTextBuilder.join('').length
          formatRanges.push({ start: codeStart, end: codeEnd, type: 'code' })
          i++
        } else {
          // Empty inline code, treat as literal backticks
          cleanTextBuilder.push('`')
        }
      } else {
        cleanTextBuilder.push('`', ...codeChars)
      }
      continue
    }

    // Check for bold+italic ***text***
    if (text.substring(i).startsWith('***')) {
      const formatStart = cleanTextBuilder.join('').length
      i += 3
      const formatChars: string[] = []
      while (i + 2 < text.length && !text.substring(i).startsWith('***')) {
        formatChars.push(text[i])
        i++
      }
      if (text.substring(i).startsWith('***')) {
        // Recursively parse the inner content for nested formatting
        const innerText = formatChars.join('')
        const innerCleanText: string[] = []
        const innerFormatRanges: FormatRange[] = []
        const innerLinkRanges: LinkRange[] = []
        parseInlineFormatting(innerText, innerCleanText, innerFormatRanges, innerLinkRanges)

        const cleanInnerText = innerCleanText.join('')
        cleanTextBuilder.push(cleanInnerText)
        const formatEnd = cleanTextBuilder.join('').length

        // Add bold and italic to the outer range
        formatRanges.push({ start: formatStart, end: formatEnd, type: 'bold' })
        formatRanges.push({ start: formatStart, end: formatEnd, type: 'italic' })

        // Add nested formatting with adjusted positions
        for (const range of innerFormatRanges) {
          formatRanges.push({
            start: formatStart + range.start,
            end: formatStart + range.end,
            type: range.type,
          })
        }
        for (const range of innerLinkRanges) {
          linkRanges.push({
            start: formatStart + range.start,
            end: formatStart + range.end,
            url: range.url,
          })
        }

        i += 3
      } else {
        cleanTextBuilder.push('***', ...formatChars)
      }
      continue
    }

    // Check for bold **text**
    if (text.substring(i).startsWith('**')) {
      const formatStart = cleanTextBuilder.join('').length
      i += 2
      const formatChars: string[] = []
      while (i + 1 < text.length && !text.substring(i).startsWith('**')) {
        formatChars.push(text[i])
        i++
      }
      if (text.substring(i).startsWith('**')) {
        // Recursively parse the inner content for nested formatting
        const innerText = formatChars.join('')
        const innerCleanText: string[] = []
        const innerFormatRanges: FormatRange[] = []
        const innerLinkRanges: LinkRange[] = []
        parseInlineFormatting(innerText, innerCleanText, innerFormatRanges, innerLinkRanges)

        const cleanInnerText = innerCleanText.join('')
        cleanTextBuilder.push(cleanInnerText)
        const formatEnd = cleanTextBuilder.join('').length

        // Add bold to the outer range
        formatRanges.push({ start: formatStart, end: formatEnd, type: 'bold' })

        // Add nested formatting with adjusted positions
        for (const range of innerFormatRanges) {
          formatRanges.push({
            start: formatStart + range.start,
            end: formatStart + range.end,
            type: range.type,
          })
        }
        for (const range of innerLinkRanges) {
          linkRanges.push({
            start: formatStart + range.start,
            end: formatStart + range.end,
            url: range.url,
          })
        }

        i += 2
      } else {
        cleanTextBuilder.push('**', ...formatChars)
      }
      continue
    }

    // Check for strikethrough ~~text~~
    if (text.substring(i).startsWith('~~')) {
      const formatStart = cleanTextBuilder.join('').length
      i += 2
      const formatChars: string[] = []
      while (i + 1 < text.length && !text.substring(i).startsWith('~~')) {
        formatChars.push(text[i])
        i++
      }
      if (text.substring(i).startsWith('~~')) {
        // Recursively parse the inner content for nested formatting
        const innerText = formatChars.join('')
        const innerCleanText: string[] = []
        const innerFormatRanges: FormatRange[] = []
        const innerLinkRanges: LinkRange[] = []
        parseInlineFormatting(innerText, innerCleanText, innerFormatRanges, innerLinkRanges)

        const cleanInnerText = innerCleanText.join('')
        cleanTextBuilder.push(cleanInnerText)
        const formatEnd = cleanTextBuilder.join('').length

        // Add strikethrough to the outer range
        formatRanges.push({ start: formatStart, end: formatEnd, type: 'strikethrough' })

        // Add nested formatting with adjusted positions
        for (const range of innerFormatRanges) {
          formatRanges.push({
            start: formatStart + range.start,
            end: formatStart + range.end,
            type: range.type,
          })
        }
        for (const range of innerLinkRanges) {
          linkRanges.push({
            start: formatStart + range.start,
            end: formatStart + range.end,
            url: range.url,
          })
        }

        i += 2
      } else {
        cleanTextBuilder.push('~~', ...formatChars)
      }
      continue
    }

    // Check for italic *text* or _text_
    // Make sure single * is not part of ** or ***
    if (
      (text[i] === '*' && text[i + 1] !== '*' && (i === 0 || text[i - 1] !== '*')) ||
      text[i] === '_'
    ) {
      const marker = text[i]
      const formatStart = cleanTextBuilder.join('').length
      i++
      const formatChars: string[] = []
      // Collect characters until we find a matching closing marker (not part of ** or ***)
      while (i < text.length) {
        if (text[i] === marker && text[i + 1] !== marker && (i === 0 || text[i - 1] !== marker)) {
          // Found the closing marker
          break
        }
        formatChars.push(text[i])
        i++
      }
      if (i < text.length && text[i] === marker) {
        // Recursively parse the inner content for nested formatting
        const innerText = formatChars.join('')
        const innerCleanText: string[] = []
        const innerFormatRanges: FormatRange[] = []
        const innerLinkRanges: LinkRange[] = []
        parseInlineFormatting(innerText, innerCleanText, innerFormatRanges, innerLinkRanges)

        const cleanInnerText = innerCleanText.join('')
        cleanTextBuilder.push(cleanInnerText)
        const formatEnd = cleanTextBuilder.join('').length

        // Add italic to the outer range
        formatRanges.push({ start: formatStart, end: formatEnd, type: 'italic' })

        // Add nested formatting with adjusted positions
        for (const range of innerFormatRanges) {
          formatRanges.push({
            start: formatStart + range.start,
            end: formatStart + range.end,
            type: range.type,
          })
        }
        for (const range of innerLinkRanges) {
          linkRanges.push({
            start: formatStart + range.start,
            end: formatStart + range.end,
            url: range.url,
          })
        }

        i++
      } else {
        cleanTextBuilder.push(marker, ...formatChars)
      }
      continue
    }

    cleanTextBuilder.push(text[i])
    i++
  }
}

function parseInlineFormattingWithoutLinks(
  text: string,
  cleanTextBuilder: string[],
  formatRanges: FormatRange[],
  _linkRanges: LinkRange[]
): void {
  let i = 0

  while (i < text.length) {
    // Check for inline code `code`
    // Skip if this is a code block delimiter (```)
    if (text[i] === '`' && !text.substring(i).startsWith('```')) {
      const codeStart = cleanTextBuilder.join('').length
      i++
      const codeChars: string[] = []
      while (i < text.length && text[i] !== '`') {
        codeChars.push(text[i])
        i++
      }
      if (i < text.length) {
        const codeContent = codeChars.join('')
        // Only apply code formatting if there's actual content
        if (codeContent.length > 0) {
          cleanTextBuilder.push(codeContent)
          const codeEnd = cleanTextBuilder.join('').length
          formatRanges.push({ start: codeStart, end: codeEnd, type: 'code' })
          i++
        } else {
          // Empty inline code, treat as literal backticks
          cleanTextBuilder.push('`')
        }
      } else {
        cleanTextBuilder.push('`', ...codeChars)
      }
      continue
    }

    // Check for bold+italic ***text***
    if (text.substring(i).startsWith('***')) {
      const formatStart = cleanTextBuilder.join('').length
      i += 3
      const formatChars: string[] = []
      while (i + 2 < text.length && !text.substring(i).startsWith('***')) {
        formatChars.push(text[i])
        i++
      }
      if (text.substring(i).startsWith('***')) {
        // Recursively parse the inner content for nested formatting
        const innerText = formatChars.join('')
        const innerCleanText: string[] = []
        const innerFormatRanges: FormatRange[] = []
        const innerLinkRanges: LinkRange[] = []
        parseInlineFormattingWithoutLinks(
          innerText,
          innerCleanText,
          innerFormatRanges,
          innerLinkRanges
        )

        const cleanInnerText = innerCleanText.join('')
        cleanTextBuilder.push(cleanInnerText)
        const formatEnd = cleanTextBuilder.join('').length

        // Add bold and italic to the outer range
        formatRanges.push({ start: formatStart, end: formatEnd, type: 'bold' })
        formatRanges.push({ start: formatStart, end: formatEnd, type: 'italic' })

        // Add nested formatting with adjusted positions
        for (const range of innerFormatRanges) {
          formatRanges.push({
            start: formatStart + range.start,
            end: formatStart + range.end,
            type: range.type,
          })
        }

        i += 3
      } else {
        cleanTextBuilder.push('***', ...formatChars)
      }
      continue
    }

    // Check for bold **text**
    if (text.substring(i).startsWith('**')) {
      const formatStart = cleanTextBuilder.join('').length
      i += 2
      const formatChars: string[] = []
      while (i + 1 < text.length && !text.substring(i).startsWith('**')) {
        formatChars.push(text[i])
        i++
      }
      if (text.substring(i).startsWith('**')) {
        // Recursively parse the inner content for nested formatting
        const innerText = formatChars.join('')
        const innerCleanText: string[] = []
        const innerFormatRanges: FormatRange[] = []
        const innerLinkRanges: LinkRange[] = []
        parseInlineFormattingWithoutLinks(
          innerText,
          innerCleanText,
          innerFormatRanges,
          innerLinkRanges
        )

        const cleanInnerText = innerCleanText.join('')
        cleanTextBuilder.push(cleanInnerText)
        const formatEnd = cleanTextBuilder.join('').length

        // Add bold to the outer range
        formatRanges.push({ start: formatStart, end: formatEnd, type: 'bold' })

        // Add nested formatting with adjusted positions
        for (const range of innerFormatRanges) {
          formatRanges.push({
            start: formatStart + range.start,
            end: formatStart + range.end,
            type: range.type,
          })
        }

        i += 2
      } else {
        cleanTextBuilder.push('**', ...formatChars)
      }
      continue
    }

    // Check for strikethrough ~~text~~
    if (text.substring(i).startsWith('~~')) {
      const formatStart = cleanTextBuilder.join('').length
      i += 2
      const formatChars: string[] = []
      while (i + 1 < text.length && !text.substring(i).startsWith('~~')) {
        formatChars.push(text[i])
        i++
      }
      if (text.substring(i).startsWith('~~')) {
        // Recursively parse the inner content for nested formatting
        const innerText = formatChars.join('')
        const innerCleanText: string[] = []
        const innerFormatRanges: FormatRange[] = []
        const innerLinkRanges: LinkRange[] = []
        parseInlineFormattingWithoutLinks(
          innerText,
          innerCleanText,
          innerFormatRanges,
          innerLinkRanges
        )

        const cleanInnerText = innerCleanText.join('')
        cleanTextBuilder.push(cleanInnerText)
        const formatEnd = cleanTextBuilder.join('').length

        // Add strikethrough to the outer range
        formatRanges.push({ start: formatStart, end: formatEnd, type: 'strikethrough' })

        // Add nested formatting with adjusted positions
        for (const range of innerFormatRanges) {
          formatRanges.push({
            start: formatStart + range.start,
            end: formatStart + range.end,
            type: range.type,
          })
        }

        i += 2
      } else {
        cleanTextBuilder.push('~~', ...formatChars)
      }
      continue
    }

    // Check for italic *text* or _text_
    // Make sure single * is not part of ** or ***
    if (
      (text[i] === '*' && text[i + 1] !== '*' && (i === 0 || text[i - 1] !== '*')) ||
      text[i] === '_'
    ) {
      const marker = text[i]
      const formatStart = cleanTextBuilder.join('').length
      i++
      const formatChars: string[] = []
      // Collect characters until we find a matching closing marker (not part of ** or ***)
      while (i < text.length) {
        if (text[i] === marker && text[i + 1] !== marker && (i === 0 || text[i - 1] !== marker)) {
          // Found the closing marker
          break
        }
        formatChars.push(text[i])
        i++
      }
      if (i < text.length && text[i] === marker) {
        // Recursively parse the inner content for nested formatting
        const innerText = formatChars.join('')
        const innerCleanText: string[] = []
        const innerFormatRanges: FormatRange[] = []
        const innerLinkRanges: LinkRange[] = []
        parseInlineFormattingWithoutLinks(
          innerText,
          innerCleanText,
          innerFormatRanges,
          innerLinkRanges
        )

        const cleanInnerText = innerCleanText.join('')
        cleanTextBuilder.push(cleanInnerText)
        const formatEnd = cleanTextBuilder.join('').length

        // Add italic to the outer range
        formatRanges.push({ start: formatStart, end: formatEnd, type: 'italic' })

        // Add nested formatting with adjusted positions
        for (const range of innerFormatRanges) {
          formatRanges.push({
            start: formatStart + range.start,
            end: formatStart + range.end,
            type: range.type,
          })
        }

        i++
      } else {
        cleanTextBuilder.push(marker, ...formatChars)
      }
      continue
    }

    cleanTextBuilder.push(text[i])
    i++
  }
}

function applyInlineFormatting(
  requests: Array<Record<string, any>>,
  formatRanges: FormatRange[],
  linkRanges: LinkRange[],
  startIndex: number
): void {
  for (const range of formatRanges) {
    // Skip empty ranges
    if (range.start >= range.end) {
      continue
    }

    const formatStart = startIndex + range.start
    const formatEnd = startIndex + range.end

    if (range.type === 'bold') {
      requests.push({
        updateTextStyle: {
          range: { startIndex: formatStart, endIndex: formatEnd },
          textStyle: { bold: true },
          fields: 'bold',
        },
      })
    } else if (range.type === 'italic') {
      requests.push({
        updateTextStyle: {
          range: { startIndex: formatStart, endIndex: formatEnd },
          textStyle: { italic: true },
          fields: 'italic',
        },
      })
    } else if (range.type === 'strikethrough') {
      requests.push({
        updateTextStyle: {
          range: { startIndex: formatStart, endIndex: formatEnd },
          textStyle: { strikethrough: true },
          fields: 'strikethrough',
        },
      })
    } else if (range.type === 'code') {
      requests.push({
        updateTextStyle: {
          range: { startIndex: formatStart, endIndex: formatEnd },
          textStyle: {
            weightedFontFamily: { fontFamily: 'Courier New' },
            backgroundColor: { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } },
          },
          fields: 'weightedFontFamily,backgroundColor',
        },
      })
    }
  }

  for (const linkRange of linkRanges) {
    // Skip empty ranges
    if (linkRange.start >= linkRange.end) {
      continue
    }

    const formatStart = startIndex + linkRange.start
    const formatEnd = startIndex + linkRange.end
    requests.push({
      updateTextStyle: {
        range: { startIndex: formatStart, endIndex: formatEnd },
        textStyle: { link: { url: linkRange.url } },
        fields: 'link',
      },
    })
  }
}
