'use client'

import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { useToast } from '@/components/ui'
import { apiMutate } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'
import type { ApplyReadyJob } from '@/components/agent-workspace/ApplyJobCard'
import type { LogEntry, QuestionOption } from '@/components/agent-workspace/live-run-types'

type ToastApi = ReturnType<typeof useToast>
type WaitingQuestion = { id: string; question: string; options: QuestionOption[] }

interface UseAgentPlaygroundActionsOptions {
  toast: ToastApi
  addLog: (entry: LogEntry) => void
  setRunLog: Dispatch<SetStateAction<LogEntry[]>>
  setWaitingQuestion: Dispatch<SetStateAction<WaitingQuestion | null>>
  setApplyQueue: Dispatch<SetStateAction<ApplyReadyJob[]>>
}

export function useAgentPlaygroundActions({
  toast, addLog, setRunLog, setWaitingQuestion, setApplyQueue,
}: UseAgentPlaygroundActionsOptions) {
  const { t } = useI18n()

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
    const { error } = await apiMutate(`/api/jobs/${jobId}/apply`, 'POST', {})
    if (error) {
      toast.error(t('agent.deliveryFailed'), error)
      throw new Error(error)
    }
    setApplyQueue(prev => prev.map(j => j.jobId === jobId ? { ...j, url: `_applied_${j.url}` } : j))
    toast.success(t('agent.markedForDelivery'), `${job.company} · ${job.role}`)
  }, [setApplyQueue, t, toast])

  return { handleAnswerQuestion, handleAnswerOrchestrator, handleApplied }
}
