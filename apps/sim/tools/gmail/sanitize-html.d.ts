declare module 'sanitize-html' {
  interface SanitizeAttributes {
    [tagName: string]: string[]
  }

  interface SanitizeOptions {
    allowedTags?: string[]
    allowedAttributes?: SanitizeAttributes
  }

  function sanitizeHtml(dirty: string, options?: SanitizeOptions): string

  export default sanitizeHtml
}
