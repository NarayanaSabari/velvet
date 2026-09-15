import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { VelvetApi, type FetchLike } from './api.js'
import {
  formatCreatedTicket,
  formatIssueList,
  formatLoggedWork,
  formatMilestones,
  formatStatusUpdate,
  formatTicket,
} from './format.js'
import { extractIssueKey } from './key.js'
import { ISSUE_STATUSES, type VelvetConfig } from './types.js'

const execFileAsync = promisify(execFile)

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
  const server = new McpServer({
    name: 'velvet-mcp',
    version: '0.1.0',
  })

  server.registerTool(
    'velvet_log_work',
    {
      description:
        'Write a factual 1-3 sentence work-log comment after completing a meaningful unit of work (progress, decision, or blocker). Never invent time spent.',
      inputSchema: {
        key: z.string().min(1).describe('Velvet issue key, such as ENG-42'),
        body: z.string().min(1).describe('The factual 1-3 sentence work-log entry'),
      },
    },
    async ({ key, body }) => {
      try {
        const normalizedKey = keyInput(key)
        const normalizedBody = body.trim()
        if (!normalizedBody) {
          return toolError(new Error('body must not be empty'))
        }
        const comment = await api.addIssueComment(normalizedKey, normalizedBody)
        return toolResult(formatLoggedWork(normalizedKey, comment))
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
        const branch = await currentBranch(cwd)
        const key = extractIssueKey(branch)
        if (!key) {
          return toolError(
            new Error(
              `no issue key found in Git branch${branch ? ` "${branch}"` : ''}; use a branch such as feature/ENG-42-fix`,
            ),
          )
        }
        const ticket = await api.getTicket(key)
        return toolResult(formatTicket(ticket, config.workspace))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_create_ticket',
    {
      description: 'Create a ticket in the configured Velvet workspace and return its key and URL.',
      inputSchema: {
        title: z.string().min(1).describe('Short ticket title'),
        description: z.string().optional().describe('Optional ticket description'),
        status: z.enum(ISSUE_STATUSES).optional().describe('Optional issue status'),
        priority: z.number().int().min(0).max(4).optional().describe('Optional priority from 0 through 4'),
        milestone_id: z.string().min(1).optional().describe('Optional milestone UUID'),
      },
    },
    async ({ title, description, status, priority, milestone_id }) => {
      try {
        const issue = await api.createIssue({
          title,
          ...(description === undefined ? {} : { description }),
          ...(status === undefined && config.defaultStatus === undefined
            ? {}
            : { status: status ?? config.defaultStatus }),
          ...(priority === undefined ? {} : { priority }),
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
      description: 'Fetch a ticket and its approximately ten most recent work-log comments.',
      inputSchema: {
        key: z.string().min(1).describe('Velvet issue key, such as ENG-42'),
      },
    },
    async ({ key }) => {
      try {
        const ticket = await api.getTicket(keyInput(key))
        return toolResult(formatTicket(ticket, config.workspace))
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
      },
    },
    async ({ status, mine }) => {
      try {
        const issues = await api.listIssues({ status, mine: mine ?? false })
        return toolResult(formatIssueList(issues, config.workspace))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_set_status',
    {
      description:
        'Set a ticket status only on an explicit user request. Never call this automatically.',
      inputSchema: {
        key: z.string().min(1).describe('Velvet issue key, such as ENG-42'),
        status: z.enum(ISSUE_STATUSES).describe('New issue status'),
      },
    },
    async ({ key, status }) => {
      try {
        const issue = await api.setIssueStatus(keyInput(key), status)
        return toolResult(formatStatusUpdate(issue, status))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'velvet_list_milestones',
    {
      description: 'List milestone IDs and names so a new ticket can be filed under a goal.',
      inputSchema: {},
    },
    async () => {
      try {
        const milestones = await api.listMilestones()
        return toolResult(formatMilestones(milestones, config.workspace))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  return server
}
