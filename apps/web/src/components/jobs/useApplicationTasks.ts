'use client'

import { useMemo } from 'react'
import { useSession } from 'next-auth/react'
import { useApi } from '@/lib/hooks'
import { parseApplicationTasks, type ApplicationTaskView } from './application-task-model'

const EMPTY_TASKS: ApplicationTaskView[] = []

/** One bounded GET per page, shared by its rows and drawer. No per-job fetch or write. */
export function useApplicationTasks({ enabled = true }: { enabled?: boolean } = {}) {
  const { data: session, status } = useSession()
  const userId = status === 'authenticated' ? session?.user?.id ?? null : null
  const active = enabled && Boolean(userId)
  const { data, loading, error, refetch } = useApi<unknown>('/api/agent/application-tasks', { cache: false, enabled: active })
  const parsed = useMemo(() => active && userId && data !== null ? parseApplicationTasks(data, userId) : null, [active, userId, data])
  // Hide old rows during refresh, on authorization errors, and synchronously on account change.
  const tasks = active && !loading && !error && parsed ? parsed.tasks : EMPTY_TASKS
  const byJobId = useMemo<ReadonlyMap<string, ApplicationTaskView>>(() => new Map(tasks.map(task => [task.jobId, task])), [tasks])
  return {
    tasks,
    byJobId,
    loading: enabled && (status === 'loading' || (active && loading)),
    error: active && !loading && (error || !parsed) ? 'unavailable' as const : null,
    limited: active && !loading && !error && parsed ? parsed.limited : false,
    refetch,
  }
}
