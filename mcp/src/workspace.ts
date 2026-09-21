import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { VelvetApi, VelvetApiError } from './api.js'

const execFileAsync = promisify(execFile)

/**
 * Finds which Velvet organisation and project the current checkout belongs to.
 *
 * An explicitly configured workspace always wins. Otherwise the git remote is
 * read once and resolved through the server, so one MCP configuration serves
 * every repository instead of each project needing its own hardcoded value.
 *
 * The result is cached for the life of the process because a running server
 * stays in one checkout, and re-reading the remote on every tool call would
 * shell out for an answer that cannot have changed.
 */
export class WorkspaceResolver {
  private cached?: Promise<ResolvedWorkspace>

  constructor(
    private readonly api: VelvetApi,
    private readonly cwd: string,
    private readonly configured: string,
  ) {}

  async resolve(): Promise<ResolvedWorkspace> {
    if (this.configured) {
      return { workspace: this.configured, explicit: true }
    }
    this.cached ??= this.discover()
    try {
      return await this.cached
    } catch (error) {
      // A failed discovery must not poison the process: a repository can be
      // connected in Velvet after the agent has already started.
      this.cached = undefined
      throw error
    }
  }

  private async discover(): Promise<ResolvedWorkspace> {
    const remote = await this.gitRemote()
    const resolved = await this.api.resolveRepo(remote)
    return {
      workspace: resolved.workspace_slug,
      explicit: false,
      ...(resolved.project_key ? { project: resolved.project_key } : {}),
    }
  }

  private async gitRemote(): Promise<string> {
    try {
      const result = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
        cwd: this.cwd,
        encoding: 'utf8',
      })
      const remote = result.stdout.trim()
      if (!remote) {
        throw new Error('origin has no URL')
      }
      return remote
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new VelvetApiError(
        `Could not read the git remote in ${this.cwd}: ${detail}. ` +
          'Set VELVET_WORKSPACE to name the organisation explicitly.',
      )
    }
  }
}

export interface ResolvedWorkspace {
  workspace: string
  /** The project this repository is mapped to, when Velvet knows one. */
  project?: string
  /** True when the workspace came from configuration rather than discovery. */
  explicit: boolean
}
