export function SignIn({ message }: { message?: string }) {
  return (
    <div className="mx-auto mt-24 max-w-sm border border-grey-200 px-6 py-8">
      <h1 className="text-lg">Work log</h1>
      <p className="mt-2 text-sm text-grey-500">
        {message ?? 'Sign in to see your sprints, milestones, and issues.'}
      </p>
      {/* A real navigation, not a fetch: OAuth has to leave the page. */}
      <a
        className="mt-4 inline-block border border-ink bg-ink px-3 py-1 text-paper transition-opacity hover:opacity-80"
        href="/api/v1/auth/github/login"
      >
        Sign in with GitHub
      </a>
    </div>
  )
}
