import type {
  Comment,
  CommentsResponse,
  CreateIssueInput,
  EvidenceRef,
  Issue,
  IssuesResponse,
  MeResponse,
  Milestone,
  MilestonesResponse,
  Project,
  ProjectsResponse,
  RepoResolution,
  TicketDetails,
  UpdateIssueInput,
  VelvetConfig,
  WorklogEntry,
  WorklogResponse,
} from './types.js'

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export class VelvetApiError extends Error {
  readonly status?: number
  readonly cause?: unknown

  constructor(message: string, status?: number, cause?: unknown) {
    super(message)
    this.name = 'VelvetApiError'
    this.status = status
    this.cause = cause
  }
}

function responseMessage(data: unknown): string {
  if (!data || typeof data !== 'object') {
    return ''
  }
  const record = data as Record<string, unknown>
  const error = record.error
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') {
      return message
    }
  }
  return typeof record.message === 'string' ? record.message : ''
}

function parseBody(raw: string): unknown {
  if (!raw) {
    return undefined
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function encodePath(value: string): string {
  return encodeURIComponent(value)
}

export class VelvetApi {
  private readonly apiRoot: string
  private readonly fetchImpl: FetchLike
  /**
   * The workspace every scoped call uses. It starts from configuration and is
   * replaced once discovery resolves the checkout, so a tool never has to know
   * which of the two supplied it.
   */
  private workspace: string

  constructor(
    private readonly config: VelvetConfig,
    fetchImpl: FetchLike = fetch,
  ) {
    this.apiRoot = `${config.baseUrl}/api/v1`
    this.fetchImpl = fetchImpl
    this.workspace = config.workspace
  }

  useWorkspace(slug: string): void {
    this.workspace = slug
  }

  get currentWorkspace(): string {
    return this.workspace
  }

  issueUrl(key: string): string {
    return `${this.config.baseUrl}/w/${encodePath(this.workspace)}/issues/${encodePath(key)}`
  }

  async resolveRepo(remote: string): Promise<RepoResolution> {
    return this.request<RepoResolution>(
      'POST',
      '/me/resolve-repo',
      { remote },
      `no connected repository matches ${remote} in any of your organisations`,
    )
  }

  /** Work-log notes against a project, for work with no ticket yet. */
  async addProjectComment(project: string, body: string, kind?: string): Promise<Comment> {
    return this.request<Comment>(
      'POST',
      `/w/${encodePath(this.workspace)}/projects/${encodePath(project)}/comments`,
      { body, ...(kind ? { kind } : {}) },
      `no such project in workspace ${this.workspace}`,
    )
  }

  async listProjects(): Promise<Project[]> {
    const response = await this.request<ProjectsResponse | Project[]>(
      'GET',
      `/w/${encodePath(this.workspace)}/projects`,
      undefined,
      `no such workspace ${this.workspace}`,
    )
    const projects = Array.isArray(response) ? response : response.projects
    return Array.isArray(projects) ? projects : []
  }

  async attachEvidence(key: string, reference: string): Promise<EvidenceRef> {
    return this.request<EvidenceRef>(
      'POST',
      `/w/${encodePath(this.workspace)}/issues/${encodePath(key)}/evidence`,
      { reference },
      `no synced pull request or commit matches ${reference}`,
    )
  }

  async myWorklog(options: { days?: number; workspace?: string; project?: string } = {}): Promise<WorklogEntry[]> {
    const query = new URLSearchParams()
    if (options.days) {
      query.set('days', String(options.days))
    }
    if (options.workspace) {
      query.set('workspace', options.workspace)
    }
    if (options.project) {
      query.set('project', options.project)
    }
    const suffix = query.toString() ? `?${query.toString()}` : ''
    const response = await this.request<WorklogResponse>('GET', `/me/worklog${suffix}`)
    return Array.isArray(response.entries) ? response.entries : []
  }

  async getMe(): Promise<MeResponse> {
    return this.request<MeResponse>('GET', '/me')
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const payload = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    )
    return this.request<Issue>(
      'POST',
      `/w/${encodePath(this.workspace)}/issues`,
      payload,
      `no such issue in workspace ${this.workspace}`,
    )
  }

  async addIssueComment(key: string, body: string, kind?: string): Promise<Comment> {
    return this.request<Comment>(
      'POST',
      `/w/${encodePath(this.workspace)}/issues/${encodePath(key)}/comments`,
      { body, ...(kind ? { kind } : {}) },
      `no such issue in workspace ${this.workspace}`,
    )
  }

  async updateIssue(key: string, patch: UpdateIssueInput): Promise<Issue> {
    return this.request<Issue>(
      'PATCH',
      `/w/${encodePath(this.workspace)}/issues/${encodePath(key)}`,
      patch,
      `no such issue in workspace ${this.workspace}`,
    )
  }

  async getIssue(key: string): Promise<Issue> {
    return this.request<Issue>(
      'GET',
      `/w/${encodePath(this.workspace)}/issues/${encodePath(key)}`,
      undefined,
      `no such issue in workspace ${this.workspace}`,
    )
  }

  async getIssueComments(key: string): Promise<Comment[]> {
    const response = await this.request<CommentsResponse>(
      'GET',
      `/w/${encodePath(this.workspace)}/issues/${encodePath(key)}/comments`,
      undefined,
      `no such issue in workspace ${this.workspace}`,
    )
    return Array.isArray(response.comments) ? response.comments : []
  }

  async getTicket(key: string): Promise<TicketDetails> {
    const [issue, comments] = await Promise.all([
      this.getIssue(key),
      this.getIssueComments(key),
    ])
    return { issue, comments }
  }

  async listIssues(options: { status?: string; mine?: boolean; project?: string } = {}): Promise<Issue[]> {
    const query = new URLSearchParams()
    if (options.status) {
      query.set('status', options.status)
    }
    if (options.project) {
      query.set('project', options.project)
    }
    if (options.mine) {
      const me = await this.getMe()
      const userId = me.user?.id
      if (!userId) {
        throw new VelvetApiError('GET /me did not return user.id')
      }
      query.set('assignee_id', userId)
    }
    const suffix = query.toString() ? `?${query.toString()}` : ''
    const response = await this.request<IssuesResponse | Issue[]>(
      'GET',
      `/w/${encodePath(this.workspace)}/issues${suffix}`,
      undefined,
      `no such issue in workspace ${this.workspace}`,
    )
    const issues = Array.isArray(response) ? response : response.issues
    return Array.isArray(issues) ? issues : []
  }

  async setIssueStatus(key: string, status: string): Promise<Issue> {
    return this.request<Issue>(
      'PATCH',
      `/w/${encodePath(this.workspace)}/issues/${encodePath(key)}`,
      { status },
      `no such issue in workspace ${this.workspace}`,
    )
  }

  async listMilestones(): Promise<Milestone[]> {
    const response = await this.request<MilestonesResponse | Milestone[]>(
      'GET',
      `/w/${encodePath(this.workspace)}/milestones`,
      undefined,
      `no such issue in workspace ${this.workspace}`,
    )
    const milestones = Array.isArray(response) ? response : response.milestones
    return Array.isArray(milestones) ? milestones : []
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    notFoundMessage?: string,
  ): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.apiRoot}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new VelvetApiError(
        `Network request to Velvet failed: ${detail}. Check VELVET_URL and connectivity.`,
        undefined,
        error,
      )
    }

    const raw = await response.text()
    const data = parseBody(raw)
    if (!response.ok) {
      let message: string
      switch (response.status) {
        case 401:
          message = 'token invalid or revoked'
          break
        case 404:
          message = notFoundMessage ?? `resource not found in workspace ${this.workspace}`
          break
        default: {
          const detail = responseMessage(data)
          message = `Velvet API returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`
          break
        }
      }
      throw new VelvetApiError(message, response.status)
    }

    if (!raw) {
      return undefined as T
    }
    if (data === undefined) {
      throw new VelvetApiError('Velvet returned an invalid JSON response.')
    }
    return data as T
  }
}
