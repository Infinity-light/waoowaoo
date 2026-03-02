/**
 * 基于段落索引的文本切分器
 * 替代原来的文本锚点匹配方案
 */

export type ParagraphClip = {
  id: string
  startParagraph: number
  endParagraph: number
  summary: string
  location: string | null
  characters: string[]
  content: string
}

/**
 * 将文本分割成段落数组
 * 支持多种段落分隔符：\n\n, \r\n\r\n, 以及单换行（如果行首有空格或特定标点）
 */
export function splitIntoParagraphs(text: string): string[] {
  // 先统一换行符
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  // 按空行分割（标准段落）
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  return paragraphs
}

/**
 * 根据段落索引提取内容
 */
export function extractByParagraphs(
  paragraphs: string[],
  startIdx: number,
  endIdx: number,
): string {
  const start = Math.max(0, startIdx)
  const end = Math.min(paragraphs.length - 1, endIdx)

  if (start > end) {
    return ''
  }

  return paragraphs.slice(start, end + 1).join('\n\n')
}

/**
 * 将原始文本映射回段落索引
 * 用于验证和调试
 */
export function findParagraphIndex(
  paragraphs: string[],
  textFragment: string,
): number {
  const normalizedFragment = textFragment.trim().replace(/\s+/g, ' ')

  for (let i = 0; i < paragraphs.length; i++) {
    const normalizedPara = paragraphs[i].replace(/\s+/g, ' ')
    if (normalizedPara.includes(normalizedFragment)) {
      return i
    }
  }

  return -1
}

/**
 * 从LLM输出解析段落切分点
 * 支持格式：CUT|段落索引|切分理由
 */
export function parseParagraphCuts(markup: string): Array<{
  paragraphIndex: number
  reason: string
}> {
  const lines = markup.split('\n').filter((l) => l.trim())
  const cuts: Array<{ paragraphIndex: number; reason: string }> = []

  for (const line of lines) {
    const match = line.match(/^CUT\|(\d+)\|(.+)$/i)
    if (match) {
      cuts.push({
        paragraphIndex: parseInt(match[1], 10),
        reason: match[2].trim(),
      })
    }
  }

  return cuts
}

/**
 * 根据切分点生成clips
 */
export function buildParagraphClips(
  paragraphs: string[],
  cuts: Array<{ paragraphIndex: number; reason?: string }>,
  summaries: string[],
  locations: (string | null)[],
  charactersList: string[][],
): ParagraphClip[] {
  if (paragraphs.length === 0) {
    return []
  }

  // 如果没有切分点，整个文本作为一个clip
  if (cuts.length === 0) {
    return [
      {
        id: 'clip_1',
        startParagraph: 0,
        endParagraph: paragraphs.length - 1,
        summary: summaries[0] || '全文',
        location: locations[0] || null,
        characters: charactersList[0] || [],
        content: paragraphs.join('\n\n'),
      },
    ]
  }

  // 排序切分点
  const sortedCuts = [...cuts].sort((a, b) => a.paragraphIndex - b.paragraphIndex)

  const clips: ParagraphClip[] = []
  let currentStart = 0

  for (let i = 0; i < sortedCuts.length; i++) {
    const cut = sortedCuts[i]
    const endParagraph = Math.min(cut.paragraphIndex, paragraphs.length - 1)

    if (currentStart <= endParagraph) {
      clips.push({
        id: `clip_${clips.length + 1}`,
        startParagraph: currentStart,
        endParagraph,
        summary: summaries[clips.length] || `片段${clips.length + 1}`,
        location: locations[clips.length] || null,
        characters: charactersList[clips.length] || [],
        content: extractByParagraphs(paragraphs, currentStart, endParagraph),
      })
      currentStart = endParagraph + 1
    }
  }

  // 处理最后一段
  if (currentStart < paragraphs.length) {
    clips.push({
      id: `clip_${clips.length + 1}`,
      startParagraph: currentStart,
      endParagraph: paragraphs.length - 1,
      summary: summaries[clips.length] || `片段${clips.length + 1}`,
      location: locations[clips.length] || null,
      characters: charactersList[clips.length] || [],
      content: extractByParagraphs(paragraphs, currentStart, paragraphs.length - 1),
    })
  }

  return clips
}
