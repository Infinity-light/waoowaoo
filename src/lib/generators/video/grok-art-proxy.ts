/**
 * grok-art-proxy 视频生成器
 *
 * 调用 POST /v1/videos/generations 端点
 * 请求：{ image_url, prompt, duration, resolution }
 * 响应：{ created, data: [{ url }] }
 */

import { BaseVideoGenerator, type GenerateResult, type VideoGenerateParams } from '../base'
import { getProviderConfig } from '@/lib/api-config'

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

export class GrokArtProxyVideoGenerator extends BaseVideoGenerator {
    private readonly providerId?: string

    constructor(providerId?: string) {
        super()
        this.providerId = providerId
    }

    protected async doGenerate(params: VideoGenerateParams): Promise<GenerateResult> {
        const { userId, imageUrl, prompt = '', options = {} } = params
        const providerId = this.providerId || 'grok-art-proxy'
        const config = await getProviderConfig(userId, providerId)

        if (!config.baseUrl) {
            throw new Error(`PROVIDER_BASE_URL_MISSING: ${config.id}`)
        }

        if (!imageUrl) {
            throw new Error('GROK_ART_PROXY_VIDEO_IMAGE_REQUIRED: image_url is required')
        }

        const allowedOptionKeys = new Set(['provider', 'modelId', 'modelKey', 'duration', 'resolution'])
        for (const [key, value] of Object.entries(options)) {
            if (value === undefined) continue
            if (!allowedOptionKeys.has(key)) {
                throw new Error(`GROK_ART_PROXY_VIDEO_OPTION_UNSUPPORTED: ${key}`)
            }
        }

        const duration = (options.duration as number | undefined) ?? 6
        const resolution = (options.resolution as string | undefined) ?? '720p'

        const endpoint = `${normalizeBaseUrl(config.baseUrl)}/v1/videos/generations`

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
                image_url: imageUrl,
                prompt: prompt.trim() || undefined,
                duration,
                resolution,
            }),
            cache: 'no-store',
        })

        if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`GROK_ART_PROXY_VIDEO_REQUEST_FAILED (${response.status}): ${errorText}`)
        }

        const data = await response.json() as { created?: number; data?: Array<{ url?: string }> }
        const videoUrl = data?.data?.[0]?.url

        if (!videoUrl) {
            throw new Error('GROK_ART_PROXY_VIDEO_EMPTY_RESPONSE: no video URL in response')
        }

        return { success: true, videoUrl }
    }
}
