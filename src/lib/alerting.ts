/**
 * 告警系统
 * 用于发送系统告警通知
 */

import { createScopedLogger } from '@/lib/logging/core'

const logger = createScopedLogger({ module: 'alerting' })

export type AlertType =
  | 'STUCK_TASK'
  | 'STUCK_TASK_TERMINATED'
  | 'HIGH_FAILURE_RATE'
  | 'QUEUE_BACKLOG'
  | 'SYSTEM_ERROR'

export interface AlertPayload {
  type: AlertType
  taskId?: string
  userId?: string
  projectId?: string
  taskType?: string
  message?: string
  details?: Record<string, unknown>
}

/**
 * 发送告警
 * 当前仅记录日志，可扩展为发送邮件/短信/钉钉等
 */
export async function sendAlert(payload: AlertPayload): Promise<void> {
  logger.warn({
    action: 'alert.sent',
    alertType: payload.type,
    ...payload
  })

  // TODO: 集成外部告警系统
  // - 钉钉 webhook
  // - 企业微信
  // - PagerDuty
  // - 邮件通知
}

/**
 * 发送任务失败告警
 */
export async function alertTaskFailure(params: {
  taskId: string
  userId: string
  projectId: string
  error: string
  retryCount: number
}): Promise<void> {
  if (params.retryCount >= 3) {
    await sendAlert({
      type: 'HIGH_FAILURE_RATE',
      ...params,
      message: `Task failed ${params.retryCount} times`
    })
  }
}
