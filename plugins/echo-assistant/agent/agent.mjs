/**
 * The agent loop: send conversation + tools to the configured LLM profile,
 * stream text deltas, execute requested tools (writes go through user
 * confirmation cards), and loop until the model produces a final answer.
 */
import { safeParseArguments } from './providers.mjs'
import { truncateToolResult } from './tools.mjs'
import { abortable, throwIfAborted } from './runtime.mjs'

const MAX_STEPS = 12
/** Images older than this many messages are dropped from the model view. */
const RECENT_IMAGE_WINDOW = 6

export function createAgent({ tools, emit, usage, getActiveProfile, createProviderCall, confirmCard }) {
  /** sessionId -> AbortController */
  const running = new Map()

  async function run({ session, signal, profile: selectedProfile, prompt: selectedPrompt }) {
    throwIfAborted(signal)
    const profile = selectedProfile ?? getActiveProfile()
    if (!profile) throw new Error('尚未配置 AI 服务，请先在右上角「设置」里添加 API 配置')
    const provider = createProviderCall(profile)
    const system = await buildSystemPrompt(profile, { systemPrompt: (selectedPrompt ?? session.prompt)?.systemPrompt })
    const lastUser = [...session.messages].reverse().find((message) => message.role === 'user')
    const userText =
      lastUser?.content
        ?.filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .slice(0, 400) ?? ''

    const controller = new AbortController()
    running.set(session.id, controller)
    const onOuterAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onOuterAbort, { once: true })
    if (signal?.aborted) onOuterAbort()

    const totalUsage = { inputTokens: 0, outputTokens: 0, cost: 0 }
    let liveText = ''
    const append = message => {
      message.id ??= `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      session.messages.push(message)
      if (!message.implicit) emit(session.id, { type: 'message', message })
    }
    try {
      for (let step = 0; step < MAX_STEPS; step += 1) {
        throwIfAborted(controller.signal)
        liveText = ''
        emit(session.id, { type: 'step', step })
        const response = await abortable(provider({
          system,
          messages: buildModelView(session.messages),
          tools: tools.list(),
          signal: controller.signal,
          onDelta: delta => {
            if (controller.signal.aborted) return
            liveText += delta
            emit(session.id, { type: 'delta', text: delta })
          }
        }), controller.signal)
        throwIfAborted(controller.signal)
        const callUsage = await usage.record({
          profileId: profile.id,
          model: profile.model,
          usage: response.usage,
          pricing: profile.pricing
        })
        totalUsage.inputTokens += callUsage.inputTokens
        totalUsage.outputTokens += callUsage.outputTokens
        totalUsage.cost = Math.round((totalUsage.cost + callUsage.cost) * 1e6) / 1e6
        emit(session.id, { type: 'usage', usage: callUsage, total: { ...totalUsage } })

        if (response.toolCalls.length) {
          append({
            role: 'assistant',
            content: response.text ? [{ type: 'text', text: response.text }] : [],
            toolCalls: response.toolCalls
          })
          liveText = ''
          for (let index = 0; index < response.toolCalls.length; index++) {
            const call = response.toolCalls[index]
            try {
              throwIfAborted(controller.signal)
              await runToolCall(session, call, controller.signal, append)
            } catch (error) {
              // Every committed call needs a result, including unstarted calls,
              // so continuing the conversation remains valid for all protocols.
              for (const pending of response.toolCalls.slice(index)) {
                if (!session.messages.some(message => message.toolCallId === pending.id)) {
                  append({ role: 'tool', toolCallId: pending.id, name: pending.name, content: [{ type: 'text', text: '用户停止了本轮操作；该工具未完成。已提交的修改可能保留。' }] })
                }
              }
              throw error
            }
          }
          continue
        }

        if (!response.text) throw new Error('模型没有返回内容，请重试或更换模型')
        append({
          role: 'assistant',
          content: [{ type: 'text', text: response.text || '（没有输出）' }]
        })
        liveText = ''
        return { reply: response.text || '（没有输出）', usage: totalUsage, userText }
      }
      append({
        role: 'assistant',
        content: [{ type: 'text', text: '这一轮工具调用步骤太多，我先停在这里。你可以让我继续或换个思路。' }]
      })
      return {
        reply: '这一轮工具调用步骤太多，我先停在这里。你可以让我继续或换个思路。',
        usage: totalUsage,
        userText
      }
    } catch (error) {
      if (liveText) append({ role: 'assistant', content: [{ type: 'text', text: liveText }], interrupted: true })
      throw error
    } finally {
      signal?.removeEventListener('abort', onOuterAbort)
      running.delete(session.id)
    }
  }

  async function runToolCall(session, call, signal, append) {
    const args = safeParseArguments(call.arguments)
    emit(session.id, { type: 'tool', status: 'start', id: call.id, name: call.name, args })
    let outcome
    try {
      const confirmWrite = card => abortable(confirmCard(session.id, card, signal), signal)
      outcome = await abortable(tools.execute(call.name, args, signal, confirmWrite), signal)
    } catch (error) {
      if (signal.aborted) throw error
      outcome = { error: error instanceof Error ? error.message : String(error) }
    }
    const resultText = truncateToolResult(outcome.value !== undefined ? outcome.value : outcome)
    append({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: [{ type: 'text', text: resultText }]
    })
    emit(session.id, {
      type: 'tool',
      id: call.id,
      status: outcome.error ? 'error' : 'done',
      name: call.name,
      error: outcome.error
    })
    const image = outcome.value && typeof outcome.value === 'object' ? outcome.value.image : null
    if (typeof image === 'string' && image.startsWith('data:image/')) {
      session.messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `[${call.name}] 结果图片` },
          { type: 'image', dataUrl: image }
        ],
        implicit: true
      })
    }
  }

  function cancel(sessionId) {
    running.get(sessionId)?.abort(new Error('已取消'))
  }

  return { run, cancel }
}

/** Model-visible message list: old images and stale tool results are trimmed. */
export function buildModelView(messages) {
  const end = messages.length
  return messages.map((message, index) => {
    const age = end - index
    if (message.role === 'tool' && age > 10) {
      return { ...message, content: [{ type: 'text', text: '[较早的工具结果已省略]' }] }
    }
    if (!Array.isArray(message.content)) return message
    const hasImage = message.content.some((block) => block.type === 'image')
    if (!hasImage || age <= RECENT_IMAGE_WINDOW) return message
    return {
      ...message,
      content: message.content.map((block) =>
        block.type === 'image' ? { type: 'text', text: '[更早的图片已省略]' } : block
      )
    }
  })
}

export async function buildSystemPrompt(profile, context) {
  const lines = [
    '你是「回声助手」，Twilight Echo 的音乐助手插件。用简洁友好的中文回答，不要输出多余客套。',
    '',
    '能力约定：',
    '- 你可以通过工具读取/修改应用设置、查询和整理本地曲库、读写歌单、控制播放、截图观察界面、查看封面。',
    '- 修改设置、改曲目元数据、创建/修改歌单属于写操作：模型只描述意图，由用户在确认卡片上决定是否执行。被拒绝时不要重复尝试，改为说明原因或给出替代方案。',
    '- 整理曲库时优先使用 find_duplicates 和 library_quality_report 这类本地统计工具，减少不必要的 token 消耗。',
    '- 打标签（mood/场景/年代）通过 create_playlist 落成歌单，歌单名建议以主题命名，例如「深夜 · 钢琴」。',
    '- 需要看界面时调用 capture_screenshot，需要看封面时调用 get_cover；描述你看到了什么再给建议。',
    '- 回答播放相关问题时可用 get_playback_info 了解当前状态。',
    '',
    `当前使用的模型：${profile.model}（${profile.protocol}）。`
  ]
  if (context?.appVersion) lines.push(`应用版本：${context.appVersion}。`)
  if (context?.profileLabel) lines.push(`API 配置：${context.profileLabel}。`)
  if (profile.vision === false) {
    lines.push('注意：当前配置声明不支持视觉。不要调用 capture_screenshot / get_cover，改为基于结构化数据分析。')
  }
  lines.push('统计报告中的 scanned 是实际扫描范围，libraryTotal 是全库数量；部分、停止或过期的结果不能当作完整曲库结论。不要声称已删除重复文件：当前工具没有文件删除能力。')
  if (context?.systemPrompt) lines.push('', '当前角色与工作偏好：', context.systemPrompt)
  return lines.join('\n')
}
