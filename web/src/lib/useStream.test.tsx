import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useStream } from './useStream'

class Stream extends EventTarget {
  static instances: Stream[] = []
  close = vi.fn()
  readonly url: string
  constructor(url: string) {
    super()
    this.url = url
    Stream.instances.push(this)
  }
}

afterEach(() => { vi.unstubAllGlobals(); Stream.instances = [] })

it('refreshes workspace lists, details and derived views on activity and reconnect without touching other workspaces', async () => {
  vi.stubGlobal('EventSource', Stream)
  const client = new QueryClient()
  const keys = ['issues', 'issue', 'sprint', 'sprints', 'milestone', 'milestones', 'comments', 'evidence', 'images', 'projects', 'activity', 'dashboard']
  const seed = () => {
    for (const key of keys) client.setQueryData([key, 'lab'], {})
    client.setQueryData(['issues', 'other'], {})
    client.setQueryData(['worklog', 7], {})
    client.setQueryData(['session'], {})
  }
  seed()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const view = renderHook(({ slug }) => useStream(slug), { initialProps: { slug: 'lab' as string | undefined }, wrapper })
  const source = Stream.instances[0]!
  expect(source.url).toBe('/api/v1/w/lab/stream')
  for (const event of ['activity', 'refresh', 'open', 'open']) {
    seed()
    await act(async () => { source.dispatchEvent(new MessageEvent(event, { data: '{}' })) })
    for (const key of keys) expect(client.getQueryState([key, 'lab'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['worklog', 7])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['issues', 'other'])?.isInvalidated).toBe(false)
    expect(client.getQueryState(['session'])?.isInvalidated).toBe(false)
  }
  view.rerender({ slug: 'lab' })
  expect(Stream.instances).toHaveLength(1)
  view.rerender({ slug: 'other' })
  expect(source.close).toHaveBeenCalledOnce()
  expect(Stream.instances).toHaveLength(2)
  seed()
  await act(async () => {
    source.dispatchEvent(new Event('activity'))
    source.dispatchEvent(new MessageEvent('refresh', { data: '{}' }))
  })
  expect(client.getQueryState(['issues', 'lab'])?.isInvalidated).toBe(false)
  view.rerender({ slug: undefined })
  expect(Stream.instances[1]!.close).toHaveBeenCalledOnce()
  expect(Stream.instances).toHaveLength(2)
})

it('refetches fresh active details on browser online even when the stream never reopens', async () => {
  vi.stubGlobal('EventSource', Stream)
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  let serverTitle = 'Before offline'
  const fetchIssue = vi.fn(async () => serverTitle)
  client.setQueryData(['issue', 'other', 'OTHER-1'], 'Other workspace')
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const view = renderHook(() => {
    useStream('lab')
    return useQuery({ queryKey: ['issue', 'lab', 'ENG-1'], queryFn: fetchIssue })
  }, { wrapper })
  await waitFor(() => expect(view.result.current.data).toBe('Before offline'))
  expect(view.result.current.isStale).toBe(false)
  await act(async () => {
    window.dispatchEvent(new Event('offline'))
    serverTitle = 'Changed while offline'
    window.dispatchEvent(new Event('online'))
  })
  await waitFor(() => expect(view.result.current.data).toBe('Changed while offline'))
  expect(fetchIssue).toHaveBeenCalledTimes(2)
  expect(Stream.instances).toHaveLength(1)
  expect(Stream.instances[0]!.close).not.toHaveBeenCalled()
  expect(client.getQueryState(['issue', 'other', 'OTHER-1'])?.isInvalidated).toBe(false)
  view.unmount()
  client.setQueryData(['issue', 'lab', 'ENG-1'], 'Fresh after cleanup')
  await act(async () => { window.dispatchEvent(new Event('online')) })
  expect(client.getQueryState(['issue', 'lab', 'ENG-1'])?.isInvalidated).toBe(false)
  expect(Stream.instances[0]!.close).toHaveBeenCalledOnce()
})
