import { Container, Link, Section } from '@react-email/components'
import { baseStyles, colors, spacing } from '@/components/emails/_styles'
import { DEFAULT_PRIVACY_URL, DEFAULT_TERMS_URL } from '@/lib/branding/defaults'
import { isHosted } from '@/lib/core/config/env-flags'
import { getBaseUrl } from '@/lib/core/utils/urls'
import { getBrandConfig } from '@/ee/whitelabeling'

interface EmailFooterProps {
  baseUrl?: string
  messageId?: string
  /**
   * Whether to show unsubscribe link. Defaults to true.
   * Set to false for transactional emails where unsubscribe doesn't apply.
   */
  showUnsubscribe?: boolean
}

/**
 * Email footer component styled to match Stripe's email design.
 * Sits in the gray area below the main white card.
 *
 * For non-transactional emails, the unsubscribe link uses placeholders
 * {{UNSUBSCRIBE_TOKEN}} and {{UNSUBSCRIBE_EMAIL}} which are replaced
 * by the mailer when sending.
 */
export function EmailFooter({
  baseUrl = getBaseUrl(),
  messageId,
  showUnsubscribe = true,
}: EmailFooterProps) {
  const brand = getBrandConfig()
  const isWhitelabeled = brand.isWhitelabeled

  return (
    <Section
      style={{
        backgroundColor: colors.footerBg,
        width: '100%',
      }}
    >
      <Container style={{ maxWidth: `${spacing.containerWidth}px`, margin: '0 auto' }}>
        <table
          cellPadding={0}
          cellSpacing={0}
          border={0}
          width='100%'
          style={{ minWidth: `${spacing.containerWidth}px` }}
        >
          <tbody>
            <tr>
              <td style={baseStyles.spacer} height={32}>
                &nbsp;
              </td>
            </tr>

            {/* Social links row — hidden for whitelabeled instances */}
            {!isWhitelabeled && (
              <>
                <tr>
                  <td style={baseStyles.gutter} width={spacing.gutter}>
                    &nbsp;
                  </td>
                  <td>
                    <table cellPadding={0} cellSpacing={0} style={{ border: 0 }}>
                      <tbody>
                        {/* <tr>
                          <td align='left' style={{ padding: '0 8px 0 0' }}>
                            <Link href={`${baseUrl}/x`} rel='noopener noreferrer'>
                              <Img
                                src={`${baseUrl}/static/x-icon.png`}
                                width='20'
                                height='20'
                                alt='X'
                                style={socialIconStyle}
                              />
                            </Link>
                          </td>
                          <td align='left' style={{ padding: '0 8px' }}>
                            <Link href={`${baseUrl}/linkedin`} rel='noopener noreferrer'>
                              <Img
                                src={`${baseUrl}/static/linkedin-icon.png`}
                                width='20'
                                height='20'
                                alt='LinkedIn'
                                style={socialIconStyle}
                              />
                            </Link>
                          </td>
                          <td align='left' style={{ padding: '0 8px' }}>
                            <Link href={`${baseUrl}/github`} rel='noopener noreferrer'>
                              <Img
                                src={`${baseUrl}/static/github-icon.png`}
                                width='20'
                                height='20'
                                alt='GitHub'
                                style={socialIconStyle}
                              />
                            </Link>
                          </td>
                          <td align='left' style={{ padding: '0 8px' }}>
                            <Link href={`${baseUrl}/slack`} rel='noopener noreferrer'>
                              <Img
                                src={`${baseUrl}/static/slack-icon.png`}
                                width='20'
                                height='20'
                                alt='Slack'
                                style={socialIconStyle}
                              />
                            </Link>
                          </td>
                        </tr> */}
                      </tbody>
                    </table>
                  </td>
                  <td style={baseStyles.gutter} width={spacing.gutter}>
                    &nbsp;
                  </td>
                </tr>
              </>
            )}

            <tr>
              <td style={baseStyles.spacer} height={16}>
                &nbsp;
              </td>
            </tr>

            {/* Address row */}
            <tr>
              <td style={baseStyles.gutter} width={spacing.gutter}>
                &nbsp;
              </td>
              <td style={baseStyles.footerText}>
                {brand.name}
                {isHosted && (
                  <>
                    , Position<sup>2</sup>, 2880 Lakeside Drive, STE 131 Santa Clara, CA 95054, USA
                  </>
                )}
              </td>
              <td style={baseStyles.gutter} width={spacing.gutter}>
                &nbsp;
              </td>
            </tr>

            <tr>
              <td style={baseStyles.spacer} height={8}>
                &nbsp;
              </td>
            </tr>

            <tr>
              <td style={baseStyles.gutter} width={spacing.gutter}>
                &nbsp;
              </td>
              <td style={baseStyles.footerText}>
                Questions?{' '}
                {/*
                  A raw anchor, not `<Link>`: react-email's Link hardcodes
                  target="_blank", which on a mailto: opens a blank tab beside
                  the compose window in most webmail clients.
                */}
                <a href={`mailto:${brand.supportEmail}`} style={baseStyles.footerLink}>
                  {brand.supportEmail}
                </a>
              </td>
              <td style={baseStyles.gutter} width={spacing.gutter}>
                &nbsp;
              </td>
            </tr>

            <tr>
              <td style={baseStyles.spacer} height={8}>
                &nbsp;
              </td>
            </tr>

            {messageId && (
              <>
                <tr>
                  <td style={baseStyles.gutter} width={spacing.gutter}>
                    &nbsp;
                  </td>
                  <td style={baseStyles.footerText}>
                    Need to refer to this message? Use this ID: {messageId}
                  </td>
                  <td style={baseStyles.gutter} width={spacing.gutter}>
                    &nbsp;
                  </td>
                </tr>
                <tr>
                  <td style={baseStyles.spacer} height={8}>
                    &nbsp;
                  </td>
                </tr>
              </>
            )}

            <tr>
              <td style={baseStyles.gutter} width={spacing.gutter}>
                &nbsp;
              </td>
              <td style={baseStyles.footerText}>
                <Link
                  href={brand.privacyUrl ?? DEFAULT_PRIVACY_URL}
                  style={baseStyles.footerLink}
                  rel='noopener noreferrer'
                >
                  Privacy Policy
                </Link>{' '}
                •{' '}
                <Link
                  href={brand.termsUrl ?? DEFAULT_TERMS_URL}
                  style={baseStyles.footerLink}
                  rel='noopener noreferrer'
                >
                  Terms of Service
                </Link>
                {showUnsubscribe && (
                  <>
                    {' '}
                    •{' '}
                    <Link
                      href={`${baseUrl}/unsubscribe?token={{UNSUBSCRIBE_TOKEN}}&email={{UNSUBSCRIBE_EMAIL}}`}
                      style={baseStyles.footerLink}
                      rel='noopener noreferrer'
                    >
                      Unsubscribe
                    </Link>
                  </>
                )}
              </td>
              <td style={baseStyles.gutter} width={spacing.gutter}>
                &nbsp;
              </td>
            </tr>

            <tr>
              <td style={baseStyles.spacer} height={16}>
                &nbsp;
              </td>
            </tr>
            <tr>
              <td style={baseStyles.gutter} width={spacing.gutter}>
                &nbsp;
              </td>
              <td style={baseStyles.footerText}>
                © {new Date().getFullYear()} {brand.name}, All Rights Reserved
              </td>
              <td style={baseStyles.gutter} width={spacing.gutter}>
                &nbsp;
              </td>
            </tr>

            <tr>
              <td style={baseStyles.spacer} height={32}>
                &nbsp;
              </td>
            </tr>
          </tbody>
        </table>
      </Container>
    </Section>
  )
}

export default EmailFooter
