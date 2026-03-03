/**
 * 统一任务状态同步机制
 *
 * 解决：DB更新和事件传播的时间差问题
 */

import Redis from 'ioredis'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { createScopedLogger } from '@/lib/logging/core'

const logger = createScopedLogger({ module: 'task.state-sync' })

export type StateChangeEvent = {
  taskId: string
  projectId: string
  userId: string
  fromStatus: string
  toStatus: string
  timestamp: number
  payload?: Record<string, unknown>
}

// Redis 客户端（单例）
let redisClient: Redis | null = null

function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
  }
  return redisClient
}

const STATE_CHANNEL = 'task:state:changes'

// 🔥 核心：原子性状态更新+事件发布
export async function atomicStateTransition(params: {
  taskId: string
  fromStatuses: string[]
  toStatus: string
  payload?: Record<string, unknown>
  result?: Record<string, unknown>
}): Promise<boolean> {
  const { taskId, fromStatuses, toStatus, payload, result } = params

  // 使用事务确保原子性
  const updated = await prisma.$transaction(async (tx) => {
    // 1. 尝试更新（带状态条件）
    const updateResult = await tx.task.updateMany({
      where: {
        id: taskId,
        status: { in: fromStatuses }
      },
      data: {
        status: toStatus,
        ...(result && { result: result as Prisma.InputJsonValue }),
        ...(toStatus === 'completed' && { progress: 100 }),
        ...(toStatus === 'completed' || toStatus === 'failed'
          ? { finishedAt: new Date(), heartbeatAt: null }
          : { heartbeatAt: new Date() }
        ),
        updatedAt: new Date()
      }
    })

    if (updateResult.count === 0) {
      return null // 状态不匹配，未更新
    }

    // 2. 读取更新后的任务
    return tx.task.findUnique({ where: { id: taskId } })
  })

  if (!updated) return false

  // 3. 发布状态变更事件（Redis Pub/Sub）
  const event: StateChangeEvent = {
    taskId: updated.id,
    projectId: updated.projectId,
    userId: updated.userId,
    fromStatus: fromStatuses[0],
    toStatus,
    timestamp: Date.now(),
    payload
  }

  try {
    const redis = getRedisClient()
    await redis.publish(STATE_CHANNEL, JSON.stringify(event))
  } catch (err) {
    logger.warn({
      action: 'state-sync.redis-publish-failed',
      message: 'Failed to publish state change event',
      error: err instanceof Error ? err.message : String(err)
    })
    // Redis 失败不影响主流程
  }

  return true
}

// 简化版状态更新（只更新，不发布事件）
export async function updateTaskStatus(
  taskId: string,
  toStatus: string,
  additionalData?: Record<string, unknown>
): Promise<boolean> {
  try {
    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: toStatus,
        ...additionalData,
        updatedAt: new Date()
      }
    })
    return true
  } catch {
    return false
  }
}

// 批量获取任务状态
export async function getTasksStatus(taskIds: string[]) {
  if (taskIds.length === 0) return []

  const tasks = await prisma.task.findMany({
    where: { id: { in: taskIds } },
    select: {
      id: true,
      status: true,
      progress: true,
      updatedAt: true,
      errorCode: true,
      errorMessage: true
    }
  })

  return tasks
}
