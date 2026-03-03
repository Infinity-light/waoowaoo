'use client'
import { logError as _ulogError } from '@/lib/logging/core'

/**
 * useBatchGeneration - 批量生成资产图片
 * 从 AssetsStage.tsx 提取
 * 
 * 🔥 V6.5 重构：直接订阅 useProjectAssets，消除 props drilling
 * 🔥 V6.6 重构：内部使用 mutation hooks，移除 onGenerateImage prop
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { CharacterAppearance } from '@/types/project'
import { useProjectAssets, useRefreshProjectAssets, useGenerateProjectCharacterImage, useGenerateProjectLocationImage, type Character } from '@/lib/query/hooks'
import { queryKeys } from '@/lib/query/keys'
import {
    createManualKeyBaseline,
    isAppearanceTaskRunning,
    shouldResolveManualKey,
    type ManualRegenerationBaseline,
} from './useBatchGeneration.helpers'

interface UseBatchGenerationProps {
    projectId: string
    // 🔥 V6.6：移除 onGenerateImage，内部使用 mutation hooks
    handleGenerateImage?: (type: 'character' | 'location', id: string, appearanceId?: string) => Promise<void> | void
}

export function useBatchGeneration({
    projectId,
    handleGenerateImage: externalHandleGenerateImage
}: UseBatchGenerationProps) {
    const t = useTranslations('assets')
    const queryClient = useQueryClient()

    // 🔥 直接订阅缓存 - 消除 props drilling
    const { data: assets } = useProjectAssets(projectId)
    const characters = useMemo(() => assets?.characters ?? [], [assets?.characters])
    const locations = useMemo(() => assets?.locations ?? [], [assets?.locations])

    // 🔥 使用刷新函数
    const refreshAssets = useRefreshProjectAssets(projectId)

    // 🔥 新增：强制刷新所有相关查询
    const forceRefreshAll = useCallback(async () => {
        // 刷新资产
        await refreshAssets()
        // 刷新任务状态
        await queryClient.invalidateQueries({
            queryKey: ['tasks', 'targetStates', projectId],
            exact: false
        })
        // 刷新活跃任务列表
        await queryClient.invalidateQueries({
            queryKey: queryKeys.tasks.all(projectId),
            exact: false
        })
    }, [refreshAssets, queryClient, projectId])

    // 🔥 V6.6：内部 mutation hooks
    const generateCharacterImage = useGenerateProjectCharacterImage(projectId)
    const generateLocationImage = useGenerateProjectLocationImage(projectId)

    // 🔥 内部图片生成函数
    const internalHandleGenerateImage = useCallback(async (type: 'character' | 'location', id: string, appearanceId?: string) => {
        if (type === 'character' && appearanceId) {
            await generateCharacterImage.mutateAsync({ characterId: id, appearanceId })
        } else if (type === 'location') {
            await generateLocationImage.mutateAsync({ locationId: id, imageIndex: 0 })
        }
    }, [generateCharacterImage, generateLocationImage])

    // 使用外部传入的函数或内部实现
    const handleGenerateImage = externalHandleGenerateImage || internalHandleGenerateImage

    const [isBatchSubmittingAll, setIsBatchSubmittingAll] = useState(false)
    const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 })
    const [pendingRegenerationKeys, setPendingRegenerationKeys] = useState<Set<string>>(new Set())
    const [pendingRegenerationBaselines, setPendingRegenerationBaselines] = useState<Map<string, ManualRegenerationBaseline>>(new Map())

    // 获取形象列表（内置实现，不再依赖外部传入）
    const getAppearances = useCallback((character: Character): CharacterAppearance[] => {
        return character.appearances || []
    }, [])

    const activeTaskKeys = useMemo(() => {
        const generated = new Set<string>()

        for (const character of characters) {
            for (const appearance of character.appearances || []) {
                if (!isAppearanceTaskRunning(appearance)) continue
                const groupKey = `character-${character.id}-${appearance.appearanceIndex}-group`
                generated.add(groupKey)
                const imageCount = Math.max(1, appearance.imageUrls?.length || 0)
                for (let index = 0; index < imageCount; index += 1) {
                    generated.add(`character-${character.id}-${appearance.appearanceIndex}-${index}`)
                }
            }
        }

        for (const location of locations) {
            const hasRunningTask = !!location.images?.some((img) => img.imageTaskRunning)
            if (!hasRunningTask) continue
            generated.add(`location-${location.id}-group`)
            for (const image of location.images || []) {
                if (image.imageTaskRunning) {
                    generated.add(`location-${location.id}-${image.imageIndex}`)
                }
            }
        }

        for (const key of pendingRegenerationKeys) {
            generated.add(key)
        }

        return generated
    }, [characters, locations, pendingRegenerationKeys])

    useEffect(() => {
        if (pendingRegenerationKeys.size === 0) return

        const now = Date.now()
        setPendingRegenerationKeys((prev) => {
            let changed = false
            const next = new Set(prev)
            for (const key of prev) {
                if (shouldResolveManualKey(key, characters, locations, pendingRegenerationBaselines, now)) {
                    next.delete(key)
                    changed = true
                }
            }
            return changed ? next : prev
        })
        setPendingRegenerationBaselines((prev) => {
            if (prev.size === 0) return prev
            let changed = false
            const next = new Map(prev)
            for (const key of Array.from(next.keys())) {
                if (!pendingRegenerationKeys.has(key)) {
                    next.delete(key)
                    changed = true
                    continue
                }
                if (shouldResolveManualKey(key, characters, locations, prev, now)) {
                    next.delete(key)
                    changed = true
                }
            }
            return changed ? next : prev
        })
    }, [characters, locations, pendingRegenerationBaselines, pendingRegenerationKeys])

    // 生成全部资产图片（仅缺失图片的）
    const handleGenerateAllImages = async () => {
        const tasks: Array<{
            type: 'character' | 'location'
            id: string
            appearanceId?: string
            appearanceIndex?: number
            key: string
        }> = []

        // 收集角色资产
        characters.forEach(char => {
            const appearances = getAppearances(char)
            appearances.forEach(app => {
                if (!app.imageUrl && !app.imageUrls?.length) {
                    tasks.push({
                        type: 'character',
                        id: char.id,
                        appearanceId: app.id,
                        appearanceIndex: app.appearanceIndex,
                        key: `character-${char.id}-${app.appearanceIndex}-group`
                    })
                }
            })
        })

        // 收集场景资产
        locations.forEach(loc => {
            const hasImage = loc.images?.some(img => img.imageUrl)
            if (!hasImage) {
                tasks.push({
                    type: 'location',
                    id: loc.id,
                    key: `location-${loc.id}-group`
                })
            }
        })

        if (tasks.length === 0) {
            alert(t('toolbar.generateAllNoop'))
            return
        }

        setIsBatchSubmittingAll(true)
        setBatchProgress({ current: 0, total: tasks.length })

        const allKeys = new Set(tasks.map(t => t.key))
        setPendingRegenerationKeys(prev => new Set([...prev, ...allKeys]))
        setPendingRegenerationBaselines(prev => {
            const next = new Map(prev)
            for (const key of allKeys) {
                const baseline = createManualKeyBaseline(key, characters, locations)
                if (baseline) {
                    next.set(key, baseline)
                }
            }
            return next
        })

        try {
            await Promise.all(
                tasks.map(async (task) => {
                    let submitted = false
                    try {
                        await handleGenerateImage(task.type, task.id, task.appearanceId)
                        submitted = true
                        setBatchProgress(prev => ({ ...prev, current: prev.current + 1 }))
                    } catch (error) {
                        _ulogError(`Failed to generate ${task.type} ${task.id}:`, error)
                        setBatchProgress(prev => ({ ...prev, current: prev.current + 1 }))
                    } finally {
                        if (submitted) return
                        setPendingRegenerationKeys(prev => {
                            const next = new Set(prev)
                            next.delete(task.key)
                            return next
                        })
                        setPendingRegenerationBaselines(prev => {
                            if (!prev.has(task.key)) return prev
                            const next = new Map(prev)
                            next.delete(task.key)
                            return next
                        })
                    }
                })
            )
        } finally {
            setIsBatchSubmittingAll(false)
            setBatchProgress({ current: 0, total: 0 })
            // 🔥 关键修复：提交后立即刷新状态
            await forceRefreshAll()
            // 2秒后再次刷新（给后端写入时间）
            setTimeout(() => forceRefreshAll(), 2000)
            // 5秒后最后一次刷新
            setTimeout(() => forceRefreshAll(), 5000)
        }
    }

    // 重新生成全部资产图片（包含已有图片的）
    const handleRegenerateAllImages = async () => {
        if (!confirm(t('toolbar.regenerateAllConfirm'))) return

        const tasks: Array<{
            type: 'character' | 'location'
            id: string
            appearanceId?: string
            appearanceIndex?: number
            key: string
        }> = []

        characters.forEach(char => {
            const appearances = getAppearances(char)
            appearances.forEach(app => {
                tasks.push({
                    type: 'character',
                    id: char.id,
                    appearanceId: app.id,
                    appearanceIndex: app.appearanceIndex,
                    key: `character-${char.id}-${app.appearanceIndex}-group`
                })
            })
        })

        locations.forEach(loc => {
            tasks.push({
                type: 'location',
                id: loc.id,
                key: `location-${loc.id}-group`
            })
        })

        if (tasks.length === 0) {
            alert(t('toolbar.noAssetsToGenerate'))
            return
        }

        setIsBatchSubmittingAll(true)
        setBatchProgress({ current: 0, total: tasks.length })

        const allKeys = new Set(tasks.map(t => t.key))
        setPendingRegenerationKeys(prev => new Set([...prev, ...allKeys]))
        setPendingRegenerationBaselines(prev => {
            const next = new Map(prev)
            for (const key of allKeys) {
                const baseline = createManualKeyBaseline(key, characters, locations)
                if (baseline) {
                    next.set(key, baseline)
                }
            }
            return next
        })

        try {
            await Promise.all(
                tasks.map(async (task) => {
                    let submitted = false
                    try {
                        await handleGenerateImage(task.type, task.id, task.appearanceId)
                        submitted = true
                        setBatchProgress(prev => ({ ...prev, current: prev.current + 1 }))
                    } catch (error) {
                        _ulogError(`Failed to generate ${task.type} ${task.id}:`, error)
                        setBatchProgress(prev => ({ ...prev, current: prev.current + 1 }))
                    } finally {
                        if (submitted) return
                        setPendingRegenerationKeys(prev => {
                            const next = new Set(prev)
                            next.delete(task.key)
                            return next
                        })
                        setPendingRegenerationBaselines(prev => {
                            if (!prev.has(task.key)) return prev
                            const next = new Map(prev)
                            next.delete(task.key)
                            return next
                        })
                    }
                })
            )
        } finally {
            setIsBatchSubmittingAll(false)
            setBatchProgress({ current: 0, total: 0 })
            // 🔥 关键修复：提交后立即刷新状态
            await forceRefreshAll()
            setTimeout(() => forceRefreshAll(), 2000)
            setTimeout(() => forceRefreshAll(), 5000)
        }
    }

    // 清除单个本地兜底状态（仅用于提交失败场景）
    const clearTransientTaskKey = useCallback((key: string) => {
        setPendingRegenerationKeys(prev => {
            const next = new Set(prev)
            next.delete(key)
            return next
        })
        setPendingRegenerationBaselines(prev => {
            if (!prev.has(key)) return prev
            const next = new Map(prev)
            next.delete(key)
            return next
        })
    }, [])

    return {
        // 🔥 暴露数据供组件使用
        characters,
        locations,
        getAppearances,
        // 状态
        isBatchSubmitting: isBatchSubmittingAll,
        batchProgress,
        activeTaskKeys,
        setTransientRegenerationKeys: setPendingRegenerationKeys,
        clearTransientTaskKey,
        // 操作
        handleGenerateAllImages,
        handleRegenerateAllImages
    }
}
