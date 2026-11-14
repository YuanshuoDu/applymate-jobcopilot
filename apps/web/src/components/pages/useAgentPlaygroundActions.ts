'use client'

import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import { useSession } from 'next-auth/react'
import { useToast } from '@/components/ui'
import { apiMutate } from '@/lib/hooks'
import { useI18n, type Lang } from '@/lib/i18n'
import type { ApplyReadyJob } from '@/components/agent-workspace/ApplyJobCard'
import { manualRecordLabel, type ManualRecordStatus } from '@/components/agent-workspace/apply-job-actions'
import type { LogEntry, QuestionOption } from '@/components/agent-workspace/live-run-types'

type ToastApi = ReturnType<typeof useToast>
type WaitingQuestion = { id: string; question: string; options: QuestionOption[] }
type ApplyMutation = (url: string, method: 'POST', body: unknown) => Promise<{ data: unknown | null; error: string | null }>

interface UseAgentPlaygroundActionsOptions {
  toast: ToastApi
  addLog: (entry: LogEntry) => void
  setRunLog: Dispatch<SetStateAction<LogEntry[]>>
  setWaitingQuestion: Dispatch<SetStateAction<WaitingQuestion | null>>
  setApplyQueue: Dispatch<SetStateAction<ApplyReadyJob[]>>
}

export interface RecordManualApplicationOptions {
  jobId: string
  userId: string
  getActiveUserId: () => string | null
  job: ApplyReadyJob
  toast: ToastApi
  setApplyQueue: Dispatch<SetStateAction<ApplyReadyJob[]>>
  lang: Lang
  mutate?: ApplyMutation
}

export async function recordManualApplication({
  jobId, userId, getActiveUserId, job, toast, setApplyQueue, lang, mutate = apiMutate,
}: RecordManualApplicationOptions) {
  const isCurrentUser = () => getActiveUserId() === userId
  const setStatus = (status: ManualRecordStatus) => {
    setApplyQueue(prev => prev.map(item => item.jobId === jobId
      ? { ...item, manualRecordStatuses: { ...item.manualRecordStatuses, [userId]: status } }
      : item))
  }

  if (!isCurrentUser()) throw new Error('The signed-in account changed before recording.')
  setStatus('pending')
  try {
    const { error } = await mutate(`/api/jobs/${jobId}/apply`, 'POST', {})
    if (error) throw new Error(error)
    setStatus('reported')
    if (isCurrentUser()) toast.success(manualRecordLabel(lang, 'reported'), `${job.company} · ${job.role}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Request outcome could not be verified'
    setStatus('unknown')
    if (isCurrentUser()) toast.error(manualRecordLabel(lang, 'unknown'), detail)
    throw error instanceof Error ? error : new Error(detail)
  }
}

export function useAgentPlaygroundActions({
  toast, addLog, setRunLog, setWaitingQuestion, setApplyQueue,
}: UseAgentPlaygroundActionsOptions) {
  const { t, lang } = useI18n()
  const { data: authSession, status: authStatus } = useSession()
  const userId = authStatus === 'authenticated' ? authSession?.user?.id ?? null : null
  const activeUserIdRef = useRef(userId)
  activeUserIdRef.current = userId

  const handleAnswerQuestion = useCallback(async (entry: LogEntry, opt: QuestionOption) => {
    if (opt.action) {
      const { field, value } = opt.action
      if (field === '_navigate') {
        window.location.href = `/?page=${value}`
        return
      }
      if (field === '_send_email') {
        const emailData = JSON.parse(value as string) as { to: string; draft: string; subject: string; jobId: string }
        const { error } = await apiMutate('/api/gmail/send-draft', 'POST', emailData)
        if (error) {
          toast.error('Email sending failed', error)
          throw new Error(error)
        }
        toast.success('Email sent', `Rejection inquiry has been sent to ${emailData.to}`)
      }
      else {
        const { error } = await apiMutate('/api/agent', 'PATCH', { [field]: value })
        if (error) {
          toast.error('Settings update failed', error)
          throw new Error(error)
        }
      }
    }
    setRunLog(prev => prev.map(l => l.questionId === entry.questionId ? { ...l, answered: true } : l))
    addLog({
      type: 'question_answered',
      message: `✓ you chose"${opt.label}"${opt.action ? ', Preference saved' : ''}`,
      time: new Date(),
    })
    toast.success('Preference recorded', opt.action ? 'Settings updated, It will take effect next time it is run' : 'Already aware, continue running')
  }, [addLog, setRunLog, toast])

  const handleAnswerOrchestrator = useCallback(async (questionId: string, answer: string, options?: QuestionOption[]) => {
    const opt = options?.find(o => o.value === answer)
    if (opt?.action && opt.action.field !== '_navigate') {
      const { error: patchError } = await apiMutate('/api/agent', 'PATCH', { [opt.action.field]: opt.action.value })
      if (patchError) {
        toast.error(t('agent.settingsUpdateFailed'), patchError)
        throw new Error(patchError)
      }
    }
    const { error } = await apiMutate('/api/agent/answer', 'POST', { questionId, answer })
    if (error) {
      toast.error(t('agent.answerFailed'), error)
      throw new Error(error)
    }
    setWaitingQuestion(null)
    setRunLog(prev => prev.map(l => l.questionId === questionId ? { ...l, answered: true } : l))
    addLog({ type: 'user_message', message: options?.find(o => o.value === answer)?.label ?? answer, time: new Date() })
  }, [addLog, setRunLog, setWaitingQuestion, t, toast])

  const handleApplied = useCallback(async (jobId: string, job: ApplyReadyJob) => {
    if (!userId) throw new Error('Sign in before recording an application.')
    await recordManualApplication({
      jobId, userId, getActiveUserId: () => activeUserIdRef.current,
      job, toast, setApplyQueue, lang,
    })
  }, [lang, setApplyQueue, toast, userId])

  return { handleAnswerQuestion, handleAnswerOrchestrator, handleApplied }
}
