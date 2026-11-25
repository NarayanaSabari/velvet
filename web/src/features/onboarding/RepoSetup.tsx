import { LoadingState } from '../../ui/QueryState'
import { ErrorNote } from '../../ui/ErrorNote'
import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Card } from '@astryxdesign/core/Card'
import { Heading } from '../../ui/Heading'
import { Link } from '@astryxdesign/core/Link'
import { Text } from '@astryxdesign/core/Text'

import { NavLink } from '../../app/nav'
import { api } from '../../lib/api'
import type { Membership, Project } from '../../lib/types'
import { Button } from '../../ui/Button'
import { Collapsible, CollapsibleGroup } from '@astryxdesign/core/Collapsible'
import { CopyField, RepoFileTabs } from './AgentSetup'
import { initCommand, loginCommand, installCommand, projectKeyFrom, repoFiles } from './repoFiles'
import { TextField } from '../../ui/fields'


const STEPS = [
  { id: 'install', title: 'Install the CLI', asNext: 'install the CLI', when: 'once per machine', help: 'Run this in a terminal on the machine your agent works on.' },
  { id: 'login', title: 'Sign in to the CLI', asNext: 'sign in to the CLI', when: 'once per machine', help: 'Run this, then compare the code it shows and approve the login in your browser.' },
  { id: 'link', title: 'Link the repository', asNext: 'link the repository', when: 'once per repository', help: 'Run this from the repository’s folder and choose its organisation and project in the terminal.' },
  { id: 'agent', title: 'Tell your agent to use it', asNext: 'tell your agent', when: 'once per repository', help: 'Add this to a file your agent already reads. The same block suits every repository.' },
] as const

/**
 * Connects a repository: install the CLI, approve login in the browser,
 * then choose the organisation and project with `velvet init` in the terminal.
 * The repository key can reach only that project. An organisation without
 * a project is offered an inline form first.
 */
export function RepoSetup({ workspace, baseUrl, hasHeading = true }: {
  workspace: Membership
  baseUrl: string
  /** Set false where the page around it has already introduced this, as onboarding does. */
  hasHeading?: boolean
}) {
  const headingId = useId()
  const canWrite = workspace.role === 'admin' || workspace.role === 'member'
  const projects = useQuery({
    queryKey: ['projects', workspace.workspace_slug, false],
    queryFn: () => api.get<{ projects: Project[] }>(`/w/${workspace.workspace_slug}/projects`),
  })
  const [creating, setCreating] = useState(false)
  const [openStep, setOpenStep] = useState<string>('install')
  const active = (projects.data?.projects ?? []).filter((project) => project.status === 'active')

  return (
    <section
      aria-labelledby={hasHeading ? headingId : undefined}
      aria-label={hasHeading ? undefined : 'Connect a repository'}
      className="space-y-4"
      data-testid="repo-setup"
    >
      {hasHeading ? (
        <div>
          <Heading level={4} accessibilityLevel={3} id={headingId}>Connect a repository</Heading>
          <Text as="p" color="secondary" display="block" className="mt-1">
            Your agent logs work with the <code>velvet</code> command. Each repository is linked to one project in{' '}
            {workspace.workspace_name}, and its key can reach only that project.
          </Text>
        </div>
      ) : null}

      {!canWrite ? (
        <p className="text-sm text-grey-700">
          You are a viewer in {workspace.workspace_name}, so you cannot connect a repository that writes. Ask an admin for member access.
        </p>
      ) : projects.isPending ? (
        <LoadingState className="">Loading projects…</LoadingState>
      ) : projects.error ? (
        <div className="space-y-2">
          <ErrorNote>Could not load projects.</ErrorNote>
          <Button className="min-h-11" onClick={() => void projects.refetch()}>Try again</Button>
        </div>
      ) : active.length === 0 || creating ? (
        <Card padding={5}>
        <div className="space-y-2">
          <Text as="p" weight="semibold" display="block">{active.length === 0 ? 'Create a project first' : 'New project'}</Text>
          <Text as="p" color="secondary" display="block">A project is the durable home for a repository's work. You pick it when you run velvet init.</Text>
          <NewProject
            slug={workspace.workspace_slug}
            onCancel={active.length > 0 ? () => setCreating(false) : undefined}
            onCreated={() => setCreating(false)}
          />
        </div>
        </Card>
      ) : (
        // One step open at a time, so the page is as long as the step being
        // done and not all four at once. Any step can be opened directly.
        <div className="border-y border-grey-200" data-testid="repo-setup-steps">
          <CollapsibleGroup type="single" value={openStep} onChange={(value) => setOpenStep(typeof value === 'string' ? value : value[0] ?? '')} hasDividers>
            {STEPS.map((step, index) => (
              <Collapsible
                key={step.id}
                value={step.id}
                trigger={(
                  <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 py-2 text-left">
                    <Text weight="semibold">{index + 1}. {step.title}</Text>
                    <Text type="supporting" color="secondary">{step.when}</Text>
                  </span>
                )}
              >
                <div className="space-y-3 pb-4">
                  <Text as="p" color="secondary" display="block">{step.help}</Text>
                  {step.id === 'install' ? <CopyField label="Install command" value={installCommand(baseUrl)} testId="cli-install" /> : null}
                  {step.id === 'login' ? <CopyField label="Login command" value={loginCommand(baseUrl)} testId="cli-login" /> : null}
                  {step.id === 'link' ? (
                    <>
                      <CopyField label="Link command" value={initCommand(baseUrl)} testId="cli-init" />
                      <p className="text-sm text-grey-500">
                        This writes velvet.yaml, which holds no secret, so commit it. Teammates run the same command to get their own key.
                        Projects: {active.map((project) => project.key).join(', ')}.{' '}
                        <Link onClick={() => setCreating(true)} hasUnderline type="inherit">New project</Link>
                      </p>
                    </>
                  ) : null}
                  {step.id === 'agent' ? <RepoFileTabs files={repoFiles()} /> : null}
                  {STEPS[index + 1] ? (
                    <Button onClick={() => setOpenStep(STEPS[index + 1]!.id)}>
                      {`Done, next: ${STEPS[index + 1]!.asNext}`}
                    </Button>
                  ) : null}
                </div>
              </Collapsible>
            ))}
          </CollapsibleGroup>
        </div>
      )}

      <p className="text-xs text-grey-500">
        Manage projects on the <NavLink to={`/w/${workspace.workspace_slug}/projects`} className="underline">Projects</NavLink> page.
      </p>
    </section>
  )
}

export function NewProject({ slug, onCancel, onCreated }: {
  slug: string
  onCancel?: () => void
  onCreated: (project: Project) => void
}) {
  const client = useQueryClient()
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [keyEdited, setKeyEdited] = useState(false)
  const create = useMutation({
    mutationFn: () => api.post<Project>(`/w/${slug}/projects`, { name: name.trim(), key: key.trim() }),
    onSuccess: async (project) => {
      await client.invalidateQueries({ queryKey: ['projects', slug] })
      onCreated(project)
    },
  })

  return (
    <form
      className="space-y-3"
      aria-label="New project"
      onSubmit={(event) => {
        event.preventDefault()
        if (!create.isPending) create.mutate()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Project name"
          value={name}
          required
          onChange={(value) => {
            setName(value)
            if (!keyEdited) setKey(projectKeyFrom(value))
          }}
        />
        <TextField
          label="Project key"
          mono
          value={key}
          required
          placeholder="velvet"
          onChange={(value) => {
            setKeyEdited(true)
            setKey(value.toLowerCase())
          }}
        />
      </div>
      <p className="text-xs text-grey-500">Lowercase letters, digits, and hyphens.</p>
      {create.error ? <ErrorNote>{create.error.message}</ErrorNote> : null}
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11" variant="primary" type="submit" disabled={create.isPending || !name.trim() || !key.trim()}>
          {create.isPending ? 'Creating…' : 'Create project'}
        </Button>
        {onCancel ? <Button className="min-h-11" onClick={onCancel} disabled={create.isPending}>Cancel</Button> : null}
      </div>
    </form>
  )
}
