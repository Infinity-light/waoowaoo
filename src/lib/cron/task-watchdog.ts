/**
 * 任务看门狗
 * 自动检测和清理卡住的任务
 */

import { prisma } from '@/lib/prisma'
import { markTaskFailed, rollbackTaskBillingForTask } from '@/lib/task/service'
import { createScopedLogger } from '@/lib/logging/core'
import { sendAlert } from '@/lib/alerting'

const logger = createScopedLogger({ module: 'task.watchdog' })

// 看门狗配置
const WATCHDOG_CONFIG = {
  // 处理中任务：2分钟无心跳视为卡死
  PROCESSING_HEARTBEAT_THRESHOLD_MS: 2 * 60 * 1000,
  // 处理中任务：最大执行时间10分钟
  PROCESSING_MAX_DURATION_MS: 10 * 60 * 1000,
  // 队列中任务：最大等待时间30分钟
  QUEUED_MAX_WAIT_MS: 30 * 60 * 1000,
  // 每次处理的最大任务数
  BATCH_SIZE: 100,
  // 检查间隔：30秒
  CHECK_INTERVAL_MS: 30 * 1000
}

let isRunning = false
let timer: NodeJS.Timeout | null = null

async function checkStuckTasks() {
  const now = new Date()
  const stuckProcessing = await prisma.task.findMany({
    where: {
      status: 'processing',
      OR: [
        // 心跳超时
        {
          heartbeatAt: {
            lt: new Date(now.getTime() - WATCHDOG_CONFIG.PROCESSING_HEARTBEAT_THRESHOLD_MS)
          }
        },
        // 执行时间超长
        {
          startedAt: {
            lt: new Date(now.getTime() - WATCHDOG_CONFIG.PROCESSING_MAX_DURATION_MS)
          }
        },
        // 有心跳但没有 startedAt（异常状态）
        {
          heartbeatAt: { not: null },
          startedAt: null
        }
      ]
    },
    take: WATCHDOG_CONFIG.BATCH_SIZE,
    orderBy: { updatedAt: 'asc' },
    select: {
      id: true,
      userId: true,
      projectId: true,
      type: true,
      status: true,
      startedAt: true,
      heartbeatAt: true,
      billingInfo: true
    }
  })

  if (stuckProcessing.length > 0) {
    logger.warn({
      action: 'watchdog.stuck-detected',
      message: `Found ${stuckProcessing.length} stuck processing tasks`,
      tasks: stuckProcessing.map(t => ({
        id: t.id,
        type: t.type,
        startedAt: t.startedAt,
        heartbeatAt: t.heartbeatAt
      }))
    })
  }

  for (const task of stuckProcessing) {
    try {
      // 尝试回滚计费
      const rollbackResult = await rollbackTaskBillingForTask({
        taskId: task.id,
        billingInfo: task.billingInfo
      })

      // 标记为失败
      await markTaskFailed(
        task.id,
        'WATCHDOG_TIMEOUT',
        `Task stuck in ${task.status} for too long (heartbeat: ${task.heartbeatAt?.toISOString() || 'none'}, started: ${task.startedAt?.toISOString() || 'none'})`
      )

      logger.info({
        action: 'watchdog.task-terminated',
        taskId: task.id,
        rollbackSuccess: rollbackResult.rolledBack
      })

      // 发送告警
      await sendAlert({
        type: 'STUCK_TASK_TERMINATED',
        taskId: task.id,
        userId: task.userId,
        projectId: task.projectId,
        taskType: task.type
      })

    } catch (err) {
      logger.error({
        action: 'watchdog.termination-failed',
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return stuckProcessing.length
}

async function checkLongQueuedTasks() {
  const now = new Date()
  const stuckQueued = await prisma.task.findMany({
    where: {
      status: 'queued',
      queuedAt: {
        lt: new Date(now.getTime() - WATCHDOG_CONFIG.QUEUED_MAX_WAIT_MS)
      }
    },
    take: WATCHDOG_CONFIG.BATCH_SIZE,
    orderBy: { queuedAt: 'asc' },
    select: {
      id: true,
      userId: true,
      projectId: true,
      type: true,
      queuedAt: true,
      billingInfo: true
    }
  })

  for (const task of stuckQueued) {
    try {
      await rollbackTaskBillingForTask({
        taskId: task.id,
        billingInfo: task.billingInfo
      })

      await markTaskFailed(
        task.id,
        'WATCHDOG_QUEUE_TIMEOUT',
        `Task stuck in queue for too long (queued at: ${task.queuedAt?.toISOString()})`
      )

      logger.info({
        action: 'watchdog.queued-task-terminated',
        taskId: task.id
      })

    } catch (err) {
      logger.error({
        action: 'watchdog.queued-termination-failed',
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return stuckQueued.length
}

// 看门狗主循环
async function watchdogLoop() {
  if (!isRunning) return

  try {
    const processingCount = await checkStuckTasks()
    const queuedCount = await checkLongQueuedTasks()

    if (processingCount > 0 || queuedCount > 0) {
      logger.info({
        action: 'watchdog.run-complete',
        terminatedProcessing: processingCount,
        terminatedQueued: queuedCount
      })
    }
  } catch (err) {
    logger.error({
      action: 'watchdog.run-failed',
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

// 启动看门狗
export function startTaskWatchdog() {
  if (isRunning) {
    logger.warn({ action: 'watchdog.already-running' })
    return
  }

  isRunning = true
  logger.info({
    action: 'watchdog.started',
    config: WATCHDOG_CONFIG
  })

  // 立即执行一次
  void watchdogLoop()

  // 定时执行
  timer = setInterval(() => {
    void watchdogLoop()
  }, WATCHDOG_CONFIG.CHECK_INTERVAL_MS)
}

// 停止看门狗
export function stopTaskWatchdog() {
  isRunning = false
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  logger.info({ action: 'watchdog.stopped' })
}

// 获取看门狗状态
export function getWatchdogStatus() {
  return {
    isRunning,
    checkIntervalMs: WATCHDOG_CONFIG.CHECK_INTERVAL_MS,
    processingThresholdMs: WATCHDOG_CONFIG.PROCESSING_HEARTBEAT_THRESHOLD_MS,
    maxDurationMs: WATCHDOG_CONFIG.PROCESSING_MAX_DURATION_MS
  }
}
