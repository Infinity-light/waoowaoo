/**
 * 任务全链路追踪
 * 用于调试和监控任务执行流程
 */

import { createScopedLogger } from '@/lib/logging/core'
import type { TaskJobData } from './types'

const logger = createScopedLogger({ module: 'task.tracing' })

export interface TaskTrace {
  taskId: string
  projectId: string
  userId: string
  type: string
  startTime: number
  stages: Array<{
    name: string
    startTime: number
    endTime?: number
    error?: string
    metadata?: Record<string, unknown>
  }>
}

const activeTraces = new Map<string, TaskTrace>()

export function startTaskTrace(taskId: string, data: TaskJobData): TaskTrace {
  const trace: TaskTrace = {
    taskId,
    projectId: data.projectId,
    userId: data.userId,
    type: data.type,
    startTime: Date.now(),
    stages: []
  }
  activeTraces.set(taskId, trace)
  return trace
}

export function addTraceStage(
  taskId: string,
  stageName: string,
  metadata?: Record<string, unknown>
) {
  const trace = activeTraces.get(taskId)
  if (!trace) return

  // 结束上一个stage
  const lastStage = trace.stages[trace.stages.length - 1]
  if (lastStage && !lastStage.endTime) {
    lastStage.endTime = Date.now()
  }

  // 开始新stage
  trace.stages.push({
    name: stageName,
    startTime: Date.now(),
    metadata
  })
}

export function endTraceStage(taskId: string, error?: string) {
  const trace = activeTraces.get(taskId)
  if (!trace) return

  const lastStage = trace.stages[trace.stages.length - 1]
  if (lastStage) {
    lastStage.endTime = Date.now()
    if (error) lastStage.error = error
  }
}

export function endTaskTrace(taskId: string, error?: string) {
  const trace = activeTraces.get(taskId)
  if (!trace) return

  // 结束最后一个stage
  const lastStage = trace.stages[trace.stages.length - 1]
  if (lastStage) {
    lastStage.endTime = Date.now()
    if (error) lastStage.error = error
  }

  // 发送到日志系统
  const duration = Date.now() - trace.startTime
  logger.info({
    action: 'task.trace.complete',
    taskId,
    duration,
    stages: trace.stages.map(s => ({
      name: s.name,
      duration: s.endTime ? s.endTime - s.startTime : null,
      error: s.error
    })),
    error
  })

  activeTraces.delete(taskId)
}

// 获取当前活跃的追踪
export function getActiveTraces(): TaskTrace[] {
  return Array.from(activeTraces.values())
}

// 获取特定任务的追踪
export function getTaskTrace(taskId: string): TaskTrace | undefined {
  return activeTraces.get(taskId)
}
