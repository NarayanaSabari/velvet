import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { api } from '../../lib/api'
import { userLabel } from '../../lib/userLabel'
import { useSession } from '../auth/useSession'
import { clearPrivateQueries, refreshPrivateQueries, navigateTo } from '../auth/sessionNavigation'
import { Button } from '../../ui/Button'

export function ProfileRoute() {
  const { slug } = useParams({ from: '/w/$slug/settings/profile' })
  return <Profile slug={slug} />
}

export function Profile({ slug }: { slug: string }) {
  const session = useSession(slug)
  const client = useQueryClient()
  const unlink = useMutation({
    mutationFn: () => api.del('/me/github'),
    onSuccess: () => refreshPrivateQueries(client),
  })
  if (session.isLoading) return <p>Loading profile…</p>
  if (!session.user) return null
  return <div className="max-w-lg space-y-4">
    <h1 className="text-lg">Profile</h1>
    <p>{userLabel(session.user)}</p>
    {session.user.email && session.user.email !== userLabel(session.user) ? <p className="text-grey-500">{session.user.email}</p> : null}
    <h2 className="border-b border-grey-200 pb-1 text-base">GitHub profile</h2>
    <p className="text-grey-500">Link your GitHub identity to attribute your work. Organisation installation ownership is verified separately in Administration.</p>
    {session.user.github_login ? <>
      <p>Linked to @{session.user.github_login}</p>
      <Button disabled={unlink.isPending} onClick={() => unlink.mutate()}>Unlink GitHub profile</Button>
    </> : <a className="underline" href="/api/v1/auth/github/link" onClick={async (event) => {
      event.preventDefault()
      await clearPrivateQueries(client)
      navigateTo('/api/v1/auth/github/link')
    }}>Link GitHub profile</a>}
    {unlink.error ? <p role="alert" className="text-blocked">{unlink.error.message}</p> : null}
  </div>
}
