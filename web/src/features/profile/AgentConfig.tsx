import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'

import type { Membership } from '../../lib/types'
import { SectionHeader } from '../../ui/PageHeader'
import { LinkedRepositories } from '../onboarding/AgentSetup'
import { onboardingQuery } from '../onboarding/onboardingQuery'
import { RepoSetup } from '../onboarding/RepoSetup'

/** Retained for existing bookmarks to this section. */
const AGENT_CONFIG_ANCHOR = 'agent-config'

/**
 * The permanent home for connecting a coding agent: install the velvet CLI,
 * link a repository with `velvet init`, and see which repositories are
 * linked. Each link mints its own key on the person's machine, limited to one
 * project, so nothing secret is ever shown on this page.
 */
export function AgentConfig({ workspace }: { workspace: Membership }) {
  const setup = useQuery(onboardingQuery)

  // A same-page link or a fresh load with #agent-config may arrive before this
  // section exists, so bring it into view once it has rendered.
  useEffect(() => {
    if (window.location.hash === `#${AGENT_CONFIG_ANCHOR}`) {
      document.getElementById(AGENT_CONFIG_ANCHOR)?.scrollIntoView()
    }
  }, [])

  const baseUrl = setup.data?.base_url ?? window.location.origin

  return (
    <section id={AGENT_CONFIG_ANCHOR} className="scroll-mt-4 space-y-3" aria-labelledby="agent-config-heading">
      <SectionHeader id="agent-config-heading" title="Agent config" />
      <p className="max-w-[46rem] text-grey-500 [overflow-wrap:anywhere]">
        Connect Claude Code, Codex, Cursor, or any agent that can run commands, so it logs your work in {workspace.workspace_name} as you go.
      </p>

      <div className="max-w-3xl space-y-5 pt-2">
        <LinkedRepositories slug={workspace.workspace_slug} workspaceName={workspace.workspace_name} />
        <RepoSetup workspace={workspace} baseUrl={baseUrl} />
        <p className="text-xs text-grey-500">
          To disconnect one repository, revoke its project key under API tokens. Running velvet logout signs out this whole machine and revokes all project keys derived from its setup key.
        </p>
      </div>
    </section>
  )
}
