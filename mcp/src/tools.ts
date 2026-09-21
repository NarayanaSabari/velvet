import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { VelvetApi, type FetchLike } from './api.js'
import {
  formatCreatedMilestone,
  formatCreatedSprint,
  formatCreatedTicket,
  formatEvidence,
  formatIssueList,
  formatLoggedWork,
  formatMilestones,
  formatProjectNote,
  formatProjects,
  formatSprints,
  formatStatusUpdate,
  formatTicket,
  formatWorklog,
} from './format.js'
import { extractIssueKey } from './key.js'
import { ISSUE_STATUSES, type VelvetConfig } from './types.js'
import { WorkspaceResolver } from './workspace.js'

const execFileAsync = promisify(execFile)

const NOTE_KINDS = ['progress', 'decision', 'blocker', 'note'] as const

// Matches the API's own date contract, so a malformed date is rejected before
// a round trip rather than after one.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const toolResult = (text: string) => ({
  content: [{ type: 'text' as const, text }],
})

const toolError = (error: unknown) => ({
  content: [{ type: 'text' as const, text: `Error: ${errorMessage(error)}` }],
  isError: true as const,
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function keyInput(value: string): string {
  return value.trim().toUpperCase()
}

async function currentBranch(cwd: string): Promise<string> {
  try {
    const result = await execFileAsync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf8',
    })
    return result.stdout.trim()
  } catch (error) {
    throw new Error(`could not read the current Git branch in ${cwd}: ${errorMessage(error)}`)
  }
}

export interface ToolServerOptions {
  cwd?: string
  fetchImpl?: FetchLike
}

export function createMcpServer(config: VelvetConfig, options: ToolServerOptions = {}): McpServer {
  const api = new VelvetApi(config, options.fetchImpl)
  const cwd = options.cwd ?? process.cwd()
  const resolver = new WorkspaceResolver(api, cwd, config.workspace)
  const server = new McpServer({
    name: 'velvet-mcp',
    version: '0.1.0',
  })

  // Every workspace-scoped tool resolves first, so one configuration works in
  // every checkout rather than each project needing its own hardcoded slug.
  const scoped = async () => {
    const resolved = await resolver.resolve()
    api.useWorkspace(resolved.workspace)
    return resolved
  }

  server.registerTool(
    'velvet_log_work',
    {
      description:
        'Write a factual 1-3 sentence work-log entry after completing a meaningful unit of work. ' +
        'Supply a ticket key when one exists; otherwise supply a project, or omit both to use the ' +
        "project this repository is mapped to. Never skip logging because no ticket exists, and never invent time spent.",
      inputSchema: {
        body: z.string().min(1).describe('The factual 1-3 sentence work-log entry'),
        key: z.string().min(1).optional().describe('Velvet issue key, such as ENG-42'),
        project: z.string().min(1).optional().describe('Project key, when there is no ticket'),
        kind: z.enum(NOTE_KINDS).optional().describe('progress, decision, blocker, or note'),
      },
    },
    async ({ body, key, project, kind }) => {
      try {
        const normalizedBody = body.trim()
        if (!normalizedBody) {
          return toolError(new Error('body must not be empty'))
        }
        const resolved = await scoped()

        if (key) {
          const normalizedKey = keyInput(key)
          const comment = await api.addIssueComment(normalizedKey, normalizedBody, kind)
          return toolResult(formatLoggedWork(normalizedKey, comment))
        }

        // Falling back to the repository's project is what keeps work from
        // going unlogged when the branch names no ticket.
        const target = project ?? resolved.project
        if (!target) {
          return toolError(
            new Error(
              'no ticket key or project given, and this repository is not mapped to a project. ' +
                'Pass project, or map the repository to one so keyless work still has a home.',
            ),
          )
        }
        const comment = await api.addProjectComment(target, normalizedBody, kind)
        return toolResult(formatProjectNote(target, comment))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_current_ticket',
    {
      description:
        'Read the current Git branch, extract an issue key such as ENG-42 case-insensitively, and fetch that ticket.',
      inputSchema: {},
    },
    async () => {
      try {
        const resolved = await scoped()
        const branch = await currentBranch(cwd)
        const key = extractIssueKey(branch)
        if (!key) {
          return toolError(
            new Error(
              `no issue key found in Git branch${branch ? ` "${branch}"` : ''}; use a branch such as feature/ENG-42-fix, ` +
                'or log work against the project instead',
            ),
          )
        }
        const ticket = await api.getTicket(key)
        return toolResult(formatTicket(ticket, resolved.workspace))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_where_am_i',
    {
      description:
        'Report which Velvet organisation and project the current checkout belongs to, resolved from its Git remote.',
      inputSchema: {},
    },
    async () => {
      try {
        const resolved = await scoped()
        const source = resolved.explicit ? 'configured' : 'resolved from the Git remote'
        const project = resolved.project ? `\nProject: ${resolved.project}` : '\nProject: (none mapped)'
        return toolResult(`Workspace: ${resolved.workspace} (${source})${project}`)
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_create_ticket',
    {
      description: 'Create a ticket in the current Velvet workspace and return its key and URL.',
      inputSchema: {
        title: z.string().min(1).describe('Short ticket title'),
        description: z.string().optional().describe('Optional ticket description'),
        status: z.enum(ISSUE_STATUSES).optional().describe('Optional issue status'),
        priority: z.number().int().min(0).max(4).optional().describe('Optional priority from 0 through 4'),
        project: z.string().min(1).optional().describe('Optional project key to file the ticket under'),
        milestone_id: z.string().min(1).optional().describe('Optional milestone UUID'),
      },
    },
    async ({ title, description, status, priority, project, milestone_id }) => {
      try {
        const resolved = await scoped()
        const issue = await api.createIssue({
          title,
          ...(description === undefined ? {} : { description }),
          ...(status === undefined && config.defaultStatus === undefined
            ? {}
            : { status: status ?? config.defaultStatus }),
          ...(priority === undefined ? {} : { priority }),
          // Default to the repository's project so a new ticket lands with the
          // work it belongs to rather than in the unfiled backlog.
          ...(project ?? resolved.project ? { project: project ?? resolved.project } : {}),
          ...(milestone_id === undefined ? {} : { milestone_id }),
        })
        return toolResult(formatCreatedTicket(issue, api.issueUrl(issue.key)))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_get_ticket',
    {
      description: 'Fetch a ticket and its approximately ten most recent work-log entries.',
      inputSchema: {
        key: z.string().min(1).describe('Velvet issue key, such as ENG-42'),
      },
    },
    async ({ key }) => {
      try {
        const resolved = await scoped()
        const ticket = await api.getTicket(keyInput(key))
        return toolResult(formatTicket(ticket, resolved.workspace))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_attach_evidence',
    {
      description:
        'Attach a pull request or commit to a ticket as proof of work. Accepts a PR URL, owner/repo#number, ' +
        'or a commit sha. This never changes the ticket status.',
      inputSchema: {
        key: z.string().min(1).describe('Velvet issue key, such as ENG-42'),
        reference: z
          .string()
          .min(1)
          .describe('A pull request URL, owner/repo#number, or a commit sha'),
      },
    },
    async ({ key, reference }) => {
      try {
        await scoped()
        const normalizedKey = keyInput(key)
        const evidence = await api.attachEvidence(normalizedKey, reference.trim())
        return toolResult(formatEvidence(normalizedKey, evidence))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_my_worklog',
    {
      description:
        'Summarise what the authenticated person worked on, across every organisation they belong to. ' +
        'Use this to answer "what was I working on" or to prepare a status update.',
      inputSchema: {
        days: z.number().int().min(1).max(365).optional().describe('How many days back, default 7'),
        workspace: z.string().min(1).optional().describe('Limit to one organisation slug'),
        project: z.string().min(1).optional().describe('Limit to one project key'),
      },
    },
    async ({ days, workspace, project }) => {
      try {
        const entries = await api.myWorklog({
          ...(days === undefined ? {} : { days }),
          ...(workspace === undefined ? {} : { workspace }),
          ...(project === undefined ? {} : { project }),
        })
        return toolResult(formatWorklog(entries))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_list_issues',
    {
      description: 'List compact ticket key, title, status, and assignee information in the workspace.',
      inputSchema: {
        status: z.enum(ISSUE_STATUSES).optional().describe('Optional issue status filter'),
        mine: z.boolean().optional().describe('Only tickets assigned to the authenticated user'),
        project: z.string().min(1).optional().describe('Only tickets filed under this project key'),
      },
    },
    async ({ status, mine, project }) => {
      try {
        const resolved = await scoped()
        const issues = await api.listIssues({
          status,
          mine: mine ?? false,
          ...(project === undefined ? {} : { project }),
        })
        return toolResult(formatIssueList(issues, resolved.workspace))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_update_ticket',
    {
      description:
        'Update a ticket title, description, priority, or project. Status is deliberately excluded: ' +
        'use velvet_set_status, and only when the user asks.',
      inputSchema: {
        key: z.string().min(1).describe('Velvet issue key, such as ENG-42'),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        priority: z.number().int().min(0).max(4).optional(),
        project: z.string().optional().describe('Project key, or an empty string to unfile it'),
        milestone_id: z
          .string()
          .optional()
          .describe('Milestone UUID to schedule this into, or an empty string to unschedule it'),
      },
    },
    async ({ key, title, description, priority, project, milestone_id }) => {
      try {
        await scoped()
        const normalizedKey = keyInput(key)
        const issue = await api.updateIssue(normalizedKey, {
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          ...(priority === undefined ? {} : { priority }),
          ...(project === undefined ? {} : { project }),
          ...(milestone_id === undefined ? {} : { milestone_id: milestone_id || null }),
        })
        return toolResult(`Updated ${issue.key}: ${issue.title}`)
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_set_status',
    {
      description:
        'Set a ticket status only on an explicit user request. Never call this automatically, and never ' +
        'because a pull request was merged.',
      inputSchema: {
        key: z.string().min(1).describe('Velvet issue key, such as ENG-42'),
        status: z.enum(ISSUE_STATUSES).describe('New issue status'),
      },
    },
    async ({ key, status }) => {
      try {
        await scoped()
        const issue = await api.setIssueStatus(keyInput(key), status)
        return toolResult(formatStatusUpdate(issue, status))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_list_projects',
    {
      description: 'List the projects in the current workspace, so work can be filed under a durable goal.',
      inputSchema: {},
    },
    async () => {
      try {
        const resolved = await scoped()
        const projects = await api.listProjects()
        return toolResult(formatProjects(projects, resolved.workspace))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_list_sprints',
    {
      description:
        'List the sprints in the current workspace with their state and dates, so work can be scheduled ' +
        'into the month it belongs to.',
      inputSchema: {},
    },
    async () => {
      try {
        const resolved = await scoped()
        const sprints = await api.listSprints()
        return toolResult(formatSprints(sprints, resolved.workspace))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_create_sprint',
    {
      description:
        'Create a sprint, the calendar window work is scheduled into. Use this when told to work in a ' +
        'sprint that does not exist yet. A new sprint starts upcoming and is not activated automatically.',
      inputSchema: {
        name: z.string().min(1).describe('Sprint name, such as "September 2026"'),
        starts_on: z.string().regex(DATE_RE).describe('First day, YYYY-MM-DD'),
        ends_on: z.string().regex(DATE_RE).describe('Last day, YYYY-MM-DD'),
      },
    },
    async ({ name, starts_on, ends_on }) => {
      try {
        await scoped()
        const sprint = await api.createSprint({ name, starts_on, ends_on })
        return toolResult(formatCreatedSprint(sprint))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_create_milestone',
    {
      description:
        'Create a milestone inside a sprint. A milestone is the goal a manager names; tickets are filed ' +
        'under it with milestone_id.',
      inputSchema: {
        sprint_id: z.string().min(1).describe('Sprint UUID from velvet_list_sprints'),
        name: z.string().min(1).describe('What this milestone is'),
        description: z.string().optional(),
        target_date: z.string().regex(DATE_RE).optional().describe('Target date, YYYY-MM-DD'),
      },
    },
    async ({ sprint_id, name, description, target_date }) => {
      try {
        await scoped()
        const milestone = await api.createMilestone(sprint_id, {
          name,
          ...(description === undefined ? {} : { description }),
          ...(target_date === undefined ? {} : { target_date }),
        })
        return toolResult(formatCreatedMilestone(milestone))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_list_milestones',
    {
      description: 'List milestone IDs and names so a new ticket can be filed under a sprint goal.',
      inputSchema: {},
    },
    async () => {
      try {
        const resolved = await scoped()
        const milestones = await api.listMilestones()
        return toolResult(formatMilestones(milestones, resolved.workspace))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  return server
}
