import { buildCharactersIntroduction } from '@/lib/constants'
import { normalizeAnyError } from '@/lib/errors/normalize'
import { createScopedLogger } from '@/lib/logging/core'
import { createClipContentMatcher, type ClipMatchLevel } from './clip-matching'
import { jsonrepair } from 'jsonrepair'

export type StoryToScriptStepMeta = {
  stepId: string
  stepAttempt?: number
  stepTitle: string
  stepIndex: number
  stepTotal: number
}

export type StoryToScriptStepOutput = {
  text: string
  reasoning: string
}

export type StoryToScriptClipCandidate = {
  id: string
  startText: string
  endText: string
  summary: string
  location: string | null
  characters: string[]
  content: string
  matchLevel: ClipMatchLevel
  matchConfidence: number
}

export type StoryToScriptScreenplayResult = {
  clipId: string
  success: boolean
  sceneCount: number
  screenplay?: Record<string, unknown>
  error?: string
}

export type StoryToScriptPromptTemplates = {
  characterPromptTemplate: string
  locationPromptTemplate: string
  clipPromptTemplate: string
  screenplayPromptTemplate: string
}

export type StoryToScriptOrchestratorInput = {
  content: string
  baseCharacters: string[]
  baseLocations: string[]
  baseCharacterIntroductions: Array<{ name: string; introduction?: string | null }>
  promptTemplates: StoryToScriptPromptTemplates
  runStep: (
    meta: StoryToScriptStepMeta,
    prompt: string,
    action: string,
    maxOutputTokens: number,
    jsonMode?: boolean,
  ) => Promise<StoryToScriptStepOutput>
  onStepError?: (meta: StoryToScriptStepMeta, message: string) => void
  onLog?: (message: string, details?: Record<string, unknown>) => void
}

export type StoryToScriptOrchestratorResult = {
  characterStep: StoryToScriptStepOutput
  locationStep: StoryToScriptStepOutput
  splitStep: StoryToScriptStepOutput
  charactersObject: Record<string, unknown>
  locationsObject: Record<string, unknown>
  analyzedCharacters: Record<string, unknown>[]
  analyzedLocations: Record<string, unknown>[]
  charactersLibName: string
  locationsLibName: string
  charactersIntroduction: string
  clipList: StoryToScriptClipCandidate[]
  screenplayResults: StoryToScriptScreenplayResult[]
  summary: {
    characterCount: number
    locationCount: number
    clipCount: number
    screenplaySuccessCount: number
    screenplayFailedCount: number
    totalScenes: number
  }
}
const orchestratorLogger = createScopedLogger({ module: 'worker.orchestrator.story_to_script' })

function applyTemplate(template: string, replacements: Record<string, string>) {
  let next = template
  for (const [key, value] of Object.entries(replacements)) {
    next = next.replace(new RegExp(`\\{${key}\\}`, 'g'), value)
  }
  return next
}

function parseJSONObject(responseText: string): Record<string, unknown> {
  let cleaned = responseText.trim()
  cleaned = cleaned
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/g, '')
    .trim()

  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1)
  }

  try {
    return JSON.parse(cleaned) as Record<string, unknown>
  } catch { /* continue */ }

  try {
    return JSON.parse(escapeControlCharsInJsonStrings(cleaned)) as Record<string, unknown>
  } catch { /* continue */ }

  try {
    return JSON.parse(fixUnescapedQuotesInJson(cleaned)) as Record<string, unknown>
  } catch { /* continue */ }

  return JSON.parse(jsonrepair(cleaned)) as Record<string, unknown>
}

function parseClipArray(responseText: string): Record<string, unknown>[] {
  let cleaned = responseText.trim()
  cleaned = cleaned
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/g, '')
    .trim()

  // Try parsing as array with progressive repair
  const firstBracket = cleaned.indexOf('[')
  const lastBracket = cleaned.lastIndexOf(']')
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    const arrayStr = cleaned.slice(firstBracket, lastBracket + 1)
    for (const repair of [identity, escapeControlCharsInJsonStrings, fixUnescapedQuotesInJson]) {
      try {
        const parsed = JSON.parse(repair(arrayStr))
        if (Array.isArray(parsed)) {
          return parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        }
      } catch { /* try next repair */ }
    }
  }

  const obj = parseJSONObject(cleaned)
  const clips = obj.clips
  if (Array.isArray(clips)) {
    return clips.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
  }

  throw new Error('Invalid clip JSON format')
}

function identity<T>(v: T): T { return v }

function escapeControlCharsInJsonStrings(input: string): string {
  let out = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (!inString) {
      if (ch === '"') inString = true
      out += ch
      continue
    }
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      out += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = false
      out += ch
      continue
    }
    if (ch === '\n') {
      out += '\\n'
      continue
    }
    if (ch === '\r') {
      out += '\\r'
      continue
    }
    if (ch === '\t') {
      out += '\\t'
      continue
    }
    const code = ch.charCodeAt(0)
    if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    out += ch
  }

  return out
}

/**
 * Attempt to fix unescaped double quotes inside JSON string values.
 *
 * The LLM sometimes converts Chinese curly quotes ("") to straight ASCII
 * double quotes (") inside a JSON string value without escaping them.
 * This produces invalid JSON such as:
 *   "text":"六耳嚣张地说，"弼马温，我是来取代你的""
 *                        ^ unescaped quote
 *
 * Strategy: walk char-by-char tracking JSON string boundaries.  When we
 * encounter a `"` that would *close* the current string but the character
 * after it is NOT a valid JSON structural char (`,`, `}`, `]`, `:`, or
 * whitespace), it is almost certainly a stray interior quote and we
 * replace it with the Chinese fullwidth left/right quote `"\u201D`.
 */
function fixUnescapedQuotesInJson(input: string): string {
  const structuralAfterString = new Set([',', '}', ']', ':', ' ', '\t', '\n', '\r'])
  let out = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]

    if (!inString) {
      if (ch === '"') inString = true
      out += ch
      continue
    }

    // Inside a JSON string
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      out += ch
      escaped = true
      continue
    }

    if (ch === '"') {
      // Is this the real closing quote, or a stray interior quote?
      const next = input[i + 1]
      if (next === undefined || structuralAfterString.has(next)) {
        // Legitimate closing quote
        inString = false
        out += ch
      } else {
        // Stray interior quote – replace with Chinese quote
        out += '\u201C'
      }
      continue
    }

    // Control character escaping (same as escapeControlCharsInJsonStrings)
    if (ch === '\n') { out += '\\n'; continue }
    if (ch === '\r') { out += '\\r'; continue }
    if (ch === '\t') { out += '\\t'; continue }
    const code = ch.charCodeAt(0)
    if (code < 0x20) { out += `\\u${code.toString(16).padStart(4, '0')}`; continue }

    out += ch
  }

  return out
}

function extractJsonFromText(text: string): string {
  // Try to find JSON object boundaries
  let braceDepth = 0
  let inString = false
  let escaped = false
  let startIdx = -1

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (!inString) {
      if (ch === '{') {
        if (braceDepth === 0) startIdx = i
        braceDepth++
      } else if (ch === '}') {
        braceDepth--
        if (braceDepth === 0 && startIdx !== -1) {
          return text.slice(startIdx, i + 1)
        }
      } else if (ch === '"') {
        inString = true
      }
    } else {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
    }
  }

  // Fallback: try simple extraction
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1)
  }

  return text
}

function aggressiveJsonRepair(input: string): string {
  // Remove markdown code blocks
  let text = input
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/g, '')
    .trim()

  // Extract JSON object
  text = extractJsonFromText(text)

  // Fix common JSON issues:
  // 1. Remove BOM
  text = text.replace(/^\uFEFF/, '')

  // 2. Fix trailing commas in arrays and objects
  text = text.replace(/,(\s*[}\]])/g, '$1')

  // 3. Fix missing commas between array elements (when ][ appears or }[ appears)
  text = text.replace(/\]\s*\[/g, '],[')
  text = text.replace(/}\s*{/g, '},{')
  text = text.replace(/}\s*\[/g, '],[')
  text = text.replace(/\]\s*{/g, '],{')

  // 4. Replace smart quotes with regular quotes in string contexts
  text = text.replace(/[\u201C\u201D]/g, '\\"')
  text = text.replace(/[\u2018\u2019]/g, "'")

  // 5. Remove control characters except \n, \r, \t
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')

  // 6. Fix unescaped newlines in strings (aggressive - replace with space)
  // This is a last resort
  text = text.replace(/(\r\n|\n|\r)(?!\s*["{}[\],])/g, '\\n')

  return text
}

function parseScreenplayObject(responseText: string): Record<string, unknown> {
  let cleaned = responseText.trim()

  // Level 1: direct parse with markdown removal
  cleaned = cleaned
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/g, '')
    .trim()

  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1)
  }

  // Level 1: direct parse
  try {
    return JSON.parse(cleaned) as Record<string, unknown>
  } catch (err) {
    orchestratorLogger.warn({
      action: 'parseScreenplay.l1_failed',
      message: 'Level 1 JSON parse failed',
      error: err instanceof Error ? err.message : String(err),
      preview: cleaned.slice(Math.max(0, (err as Error).message.match(/position (\d+)/)?.[1] ? parseInt((err as Error).message.match(/position (\d+)/)![1]) - 50 : 5400), Math.min(cleaned.length, (err as Error).message.match(/position (\d+)/)?.[1] ? parseInt((err as Error).message.match(/position (\d+)/)![1]) + 50 : 5450)),
      length: cleaned.length,
    })
  }

  // Level 2: escape control characters
  try {
    return JSON.parse(escapeControlCharsInJsonStrings(cleaned)) as Record<string, unknown>
  } catch { /* continue */ }

  // Level 3: fix unescaped interior double quotes + control chars
  try {
    return JSON.parse(fixUnescapedQuotesInJson(cleaned)) as Record<string, unknown>
  } catch { /* continue */ }

  // Level 4: aggressive repair
  try {
    const repaired = aggressiveJsonRepair(responseText)
    return JSON.parse(repaired) as Record<string, unknown>
  } catch { /* continue */ }

  // Level 5: structural repair (truncation, missing commas, etc.)
  try {
    return JSON.parse(jsonrepair(cleaned)) as Record<string, unknown>
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    // Extract position from error message like "position 5864"
    const posMatch = errMsg.match(/position (\d+)/)
    const pos = posMatch ? parseInt(posMatch[1]) : null
    const previewAround = pos !== null
      ? cleaned.slice(Math.max(0, pos - 100), Math.min(cleaned.length, pos + 100))
      : cleaned.slice(0, 200)

    orchestratorLogger.error({
      action: 'parseScreenplay.failed',
      message: 'All JSON parse levels failed',
      error: errMsg,
      previewStart: cleaned.slice(0, 200),
      previewError: cleaned.slice(Math.max(0, cleaned.length / 2 - 100), Math.min(cleaned.length, cleaned.length / 2 + 100)),
      previewEnd: cleaned.slice(-200),
      length: cleaned.length,
    })

    // Include preview in thrown error so it appears in UI
    throw new Error(
      `JSON parse failed at ${pos ?? 'unknown'}: ${errMsg}. ` +
      `Preview around error: ...${previewAround.replace(/\s+/g, ' ')}...`,
    )
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
}

function toObjectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
}

function extractAnalyzedCharacters(obj: Record<string, unknown>): Record<string, unknown>[] {
  const primary = toObjectArray(obj.characters)
  if (primary.length > 0) return primary
  return toObjectArray(obj.new_characters)
}

function extractAnalyzedLocations(obj: Record<string, unknown>): Record<string, unknown>[] {
  return toObjectArray(obj.locations)
}

const MAX_STEP_ATTEMPTS = 3
const MAX_SPLIT_BOUNDARY_ATTEMPTS = 2
const MAX_RETRY_DELAY_MS = 10_000
const CLIP_BOUNDARY_SUFFIX = `

[Boundary Constraints]
1. The "start" and "end" anchors must come from the original text and be locatable.
2. Allow punctuation/whitespace differences, but do not rewrite key entities or events.
3. If anchors cannot be located reliably, return [] directly.`

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function computeRetryDelayMs(attempt: number) {
  const base = Math.min(1_000 * Math.pow(2, Math.max(0, attempt - 1)), MAX_RETRY_DELAY_MS)
  const jitter = Math.floor(Math.random() * 300)
  return base + jitter
}

async function runStepWithRetry<T>(
  runStep: StoryToScriptOrchestratorInput['runStep'],
  baseMeta: StoryToScriptStepMeta,
  prompt: string,
  action: string,
  maxOutputTokens: number,
  parse: (text: string) => T,
  jsonMode?: boolean,
): Promise<{ output: StoryToScriptStepOutput; parsed: T }> {
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
    const meta = attempt === 1
      ? baseMeta
      : {
        ...baseMeta,
        stepId: baseMeta.stepId,
        stepAttempt: attempt,
        stepTitle: baseMeta.stepTitle,
      }
    try {
      const output = await runStep(meta, prompt, action, maxOutputTokens, jsonMode)
      const parsed = parse(output.text)
      return { output, parsed }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const normalizedError = normalizeAnyError(error, { context: 'worker' })
      const lowerMessage = normalizedError.message.toLowerCase()
      const shouldRetry = attempt < MAX_STEP_ATTEMPTS
        && (
          normalizedError.retryable
          || lowerMessage.includes('json')
          || lowerMessage.includes('parse')
        )

      orchestratorLogger.error({
        action: 'orchestrator.step.retry',
        message: shouldRetry ? 'step failed, retrying' : 'step failed, no more retry',
        errorCode: normalizedError.code,
        retryable: normalizedError.retryable,
        details: {
          stepId: baseMeta.stepId,
          action,
          attempt,
          maxAttempts: MAX_STEP_ATTEMPTS,
        },
        error: {
          name: lastError.name,
          message: lastError.message,
          stack: lastError.stack,
        },
      })

      if (!shouldRetry) {
        break
      }
      await wait(computeRetryDelayMs(attempt))
    }
  }
  throw lastError!
}

export async function runStoryToScriptOrchestrator(
  input: StoryToScriptOrchestratorInput,
): Promise<StoryToScriptOrchestratorResult> {
  const {
    content,
    baseCharacters,
    baseLocations,
    baseCharacterIntroductions,
    promptTemplates,
    runStep,
    onStepError,
    onLog,
  } = input

  const baseCharactersText = baseCharacters.length > 0 ? baseCharacters.join('、') : '无'
  const baseLocationsText = baseLocations.length > 0 ? baseLocations.join('、') : '无'
  const baseCharacterInfo = baseCharacterIntroductions.length > 0
    ? baseCharacterIntroductions.map((item, index) => `${index + 1}. ${item.name}`).join('\n')
    : '暂无已有角色'

  const characterPrompt = applyTemplate(promptTemplates.characterPromptTemplate, {
    input: content,
    characters_lib_name: baseCharactersText,
    characters_lib_info: baseCharacterInfo,
  })
  const locationPrompt = applyTemplate(promptTemplates.locationPromptTemplate, {
    input: content,
    locations_lib_name: baseLocationsText,
  })

  onLog?.('开始步骤1：角色/场景分析（并行）')
  const [
    { output: characterStep, parsed: charactersObject },
    { output: locationStep, parsed: locationsObject },
  ] = await Promise.all([
    runStepWithRetry(
      runStep,
      { stepId: 'analyze_characters', stepTitle: 'progress.streamStep.analyzeCharacters', stepIndex: 1, stepTotal: 2 },
      characterPrompt,
      'analyze_characters',
      2200,
      parseJSONObject,
    ),
    runStepWithRetry(
      runStep,
      { stepId: 'analyze_locations', stepTitle: 'progress.streamStep.analyzeLocations', stepIndex: 2, stepTotal: 2 },
      locationPrompt,
      'analyze_locations',
      2200,
      parseJSONObject,
    ),
  ])

  const analyzedCharacters = extractAnalyzedCharacters(charactersObject)
  const analyzedLocations = extractAnalyzedLocations(locationsObject)

  const analyzedCharacterNames = analyzedCharacters
    .map((item) => asString(item.name).trim())
    .filter(Boolean)
  const analyzedLocationNames = analyzedLocations
    .map((item) => asString(item.name).trim())
    .filter(Boolean)

  // 合并新发现角色与已有角色库（新角色优先，已有角色补充），避免已有角色被覆盖丢失
  const analyzedCharacterNameSet = new Set(analyzedCharacterNames)
  const mergedCharacterNames = [
    ...analyzedCharacterNames,
    ...baseCharacters.filter((name) => !analyzedCharacterNameSet.has(name)),
  ]
  const charactersLibName = mergedCharacterNames.length > 0
    ? mergedCharacterNames.join('、')
    : baseCharactersText

  const locationsLibName = analyzedLocationNames.length > 0
    ? analyzedLocationNames.join('、')
    : baseLocationsText

  // 合并角色介绍：新角色 + 未被新角色覆盖的已有角色介绍
  const mergedCharacterIntroductions = [
    ...analyzedCharacters.map((item) => ({
      name: asString(item.name),
      introduction: asString(item.introduction),
    })),
    ...baseCharacterIntroductions
      .filter((item) => !analyzedCharacterNameSet.has(item.name))
      .map((item) => ({
        name: item.name,
        introduction: item.introduction || '',
      })),
  ]
  const charactersIntroduction = buildCharactersIntroduction(
    mergedCharacterIntroductions.length > 0
      ? mergedCharacterIntroductions
      : baseCharacterIntroductions.map((item) => ({
        name: item.name,
        introduction: item.introduction || '',
      })),
  )

  onLog?.('开始步骤2：片段切分（最多重试1次）', {
    charactersLibName,
    locationsLibName,
  })

  const splitPromptBase = applyTemplate(promptTemplates.clipPromptTemplate, {
    input: content,
    locations_lib_name: locationsLibName || '无',
    characters_lib_name: charactersLibName || '无',
    characters_introduction: charactersIntroduction || '暂无角色介绍',
  })
  const splitPrompt = `${splitPromptBase}${CLIP_BOUNDARY_SUFFIX}`

  let splitStep: StoryToScriptStepOutput | null = null
  let clipList: StoryToScriptClipCandidate[] = []
  let lastBoundaryError: Error | null = null

  for (let attempt = 1; attempt <= MAX_SPLIT_BOUNDARY_ATTEMPTS; attempt += 1) {
    const splitMeta: StoryToScriptStepMeta = {
      stepId: 'split_clips',
      stepAttempt: attempt,
      stepTitle: 'progress.streamStep.splitClips',
      stepIndex: 1,
      stepTotal: 1,
    }

    const { output, parsed: rawClipList } = await runStepWithRetry(
      runStep,
      splitMeta,
      splitPrompt,
      'split_clips',
      2600,
      parseClipArray,
    )
    if (rawClipList.length === 0) {
      lastBoundaryError = new Error('split_clips returned empty clips')
      onLog?.('片段切分结果为空', {
        attempt,
        maxAttempts: MAX_SPLIT_BOUNDARY_ATTEMPTS,
      })
      continue
    }

    const matcher = createClipContentMatcher(content)
    const nextClipList: StoryToScriptClipCandidate[] = []
    let searchFrom = 0
    let failedAt: { clipId: string; startText: string; endText: string } | null = null

    for (let index = 0; index < rawClipList.length; index += 1) {
      const item = rawClipList[index]
      const startText = asString(item.start)
      const endText = asString(item.end)
      const clipId = `clip_${index + 1}`
      const match = matcher.matchBoundary(startText, endText, searchFrom)
      if (!match) {
        failedAt = { clipId, startText, endText }
        break
      }

      nextClipList.push({
        id: clipId,
        startText,
        endText,
        summary: asString(item.summary),
        location: asString(item.location) || null,
        characters: toStringArray(item.characters),
        content: content.slice(match.startIndex, match.endIndex),
        matchLevel: match.level,
        matchConfidence: match.confidence,
      })
      searchFrom = match.endIndex
    }

    if (!failedAt) {
      splitStep = output
      clipList = nextClipList
      const levelCount: Record<ClipMatchLevel, number> = { L1: 0, L2: 0, L3: 0 }
      for (const clip of nextClipList) {
        levelCount[clip.matchLevel] += 1
      }
      onLog?.('片段边界匹配成功', {
        attempt,
        clipCount: nextClipList.length,
        levelCount,
      })
      break
    }

    lastBoundaryError = new Error(
      `split_clips boundary matching failed at ${failedAt.clipId}: start="${failedAt.startText}" end="${failedAt.endText}"`,
    )
    onLog?.('片段边界匹配失败', {
      attempt,
      maxAttempts: MAX_SPLIT_BOUNDARY_ATTEMPTS,
      failedClip: failedAt.clipId,
      startText: failedAt.startText,
      endText: failedAt.endText,
    })
  }

  if (!splitStep) {
    throw lastBoundaryError || new Error('split_clips boundary matching failed')
  }

  onLog?.('开始步骤3：对每个片段做剧本转换（并行）', { clipCount: clipList.length })

  const screenplayResults = await Promise.all(
    clipList.map(async (clip, index): Promise<StoryToScriptScreenplayResult> => {
      const stepMeta: StoryToScriptStepMeta = {
        stepId: `screenplay_${clip.id}`,
        stepTitle: 'progress.streamStep.screenplayConversion',
        stepIndex: index + 1,
        stepTotal: clipList.length || 1,
      }

      try {
        const screenplayPrompt = applyTemplate(promptTemplates.screenplayPromptTemplate, {
          clip_content: clip.content,
          locations_lib_name: locationsLibName || '无',
          characters_lib_name: charactersLibName || '无',
          characters_introduction: charactersIntroduction || '暂无角色介绍',
          clip_id: clip.id,
        })

        const { parsed: screenplay } = await runStepWithRetry(
          runStep,
          stepMeta,
          screenplayPrompt,
          'screenplay_conversion',
          65535,
          parseScreenplayObject,
          true, // jsonMode: 强制模型输出合法 JSON（治本方案）
        )
        const scenes = Array.isArray(screenplay.scenes) ? screenplay.scenes : []
        return {
          clipId: clip.id,
          success: true,
          sceneCount: scenes.length,
          screenplay,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        onStepError?.(stepMeta, message)
        return {
          clipId: clip.id,
          success: false,
          sceneCount: 0,
          error: message,
        }
      }
    }),
  )

  const screenplaySuccessCount = screenplayResults.filter((item) => item.success).length
  const screenplayFailedCount = screenplayResults.length - screenplaySuccessCount
  const totalScenes = screenplayResults.reduce((sum, item) => sum + item.sceneCount, 0)

  return {
    characterStep,
    locationStep,
    splitStep,
    charactersObject,
    locationsObject,
    analyzedCharacters,
    analyzedLocations,
    charactersLibName,
    locationsLibName,
    charactersIntroduction,
    clipList,
    screenplayResults,
    summary: {
      characterCount: analyzedCharacters.length,
      locationCount: analyzedLocations.length,
      clipCount: clipList.length,
      screenplaySuccessCount,
      screenplayFailedCount,
      totalScenes,
    },
  }
}
