import { useId, type ReactNode } from 'react'
import { Heading } from '@astryxdesign/core/Heading'
import { Text } from '@astryxdesign/core/Text'

import { PublicPageLayout } from '../landing/PublicPageLayout'

/**
 * The frame for sign-in and the pages around it. The task leads: the title,
 * one line of help and the action sit together as one block centred in the
 * panel. `expanded` is for the longer tasks (onboarding, connecting the CLI),
 * which take a centred bordered surface without the landing content.
 */
export function PublicAuthPage({ title, children, expanded = false, lead, account }: {
  title: string
  children: ReactNode
  expanded?: boolean
  /** One line under the title saying what to do here. */
  lead?: ReactNode
  /** Who is signed in and the ways out, across the top of a longer task page. */
  account?: ReactNode
}) {
  const headingId = useId()

  if (expanded) {
    // The same order as the sign-in pages: who you are, then the task as a
    // title with one line of help, then the work.
    return (
      <PublicPageLayout signingIn title={title} expanded>
        <section aria-labelledby={headingId} className="landing-signin landing-signin-task">
          {account}
          <Heading level={1} id={headingId} className="landing-signin-title">{title}</Heading>
          {lead ? <Text as="p" color="secondary" display="block" className="mt-3 max-w-[40rem]">{lead}</Text> : null}
          <div className="mt-8">{children}</div>
        </section>
      </PublicPageLayout>
    )
  }

  return (
    <PublicPageLayout signingIn title={title} refined>
      <section aria-labelledby={headingId} className="landing-signin landing-signin-refined">
        <div className="landing-signin-block">
          <Heading level={1} id={headingId} className="landing-signin-title">{title}</Heading>
          {lead ? <Text as="p" color="secondary" display="block" className="mt-3">{lead}</Text> : null}
          <div className="mt-8">{children}</div>
        </div>
      </section>
    </PublicPageLayout>
  )
}
