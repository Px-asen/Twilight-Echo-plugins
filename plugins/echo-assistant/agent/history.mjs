/**
 * Conversation persistence in the plugin's private data directory.
 * Images (screenshots/covers) are replaced with placeholders on save so
 * history files stay small; the model sees the live image during the run.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_SESSIONS = 60
const MAX_MESSAGES_PER_SESSION = 400
const TITLE_MAX = 60

export function createHistory({ storagePath }) {
  const sessionsDir = join(storagePath, 'sessions')
  const writes = new Map()

  function sessionPath(id) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('无效的会话 id')
    return join(sessionsDir, `${id}.json`)
  }

  async function ensureDir() {
    await mkdir(sessionsDir, { recursive: true })
  }

  async function writeAtomic(file, text) {
    const temp = `${file}.tmp`
    await writeFile(temp, text, 'utf8')
    await rename(temp, file)
  }

  async function createSession() {
    await ensureDir()
    const session = {
      id: `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title: '新对话',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: []
    }
    await writeAtomic(sessionPath(session.id), JSON.stringify(session))
    return session
  }

  async function loadSession(id) {
    try {
      return JSON.parse(await readFile(sessionPath(id), 'utf8'))
    } catch {
      return null
    }
  }

  async function listSessions() {
    await ensureDir()
    const files = await readdir(sessionsDir)
    const sessions = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const session = JSON.parse(await readFile(join(sessionsDir, file), 'utf8'))
        if (session?.id) {
          sessions.push({
            id: session.id,
            title: session.title || '对话',
            updatedAt: session.updatedAt,
            messageCount: Array.isArray(session.messages) ? session.messages.length : 0
          })
        }
      } catch {
        /* skip corrupt files */
      }
    }
    sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return sessions.slice(0, MAX_SESSIONS)
  }

  async function saveSession(session) {
    session.updatedAt = new Date().toISOString()
    const text = JSON.stringify({ ...session, messages: trimMessages(session.messages ?? []) })
    const previous = writes.get(session.id) ?? Promise.resolve()
    const write = previous.catch(() => {}).then(async () => {
      await ensureDir()
      await writeAtomic(sessionPath(session.id), text)
    })
    writes.set(session.id, write)
    try { await write } finally { if (writes.get(session.id) === write) writes.delete(session.id) }
    return session
  }

  async function deleteSession(id) {
    await rm(sessionPath(id), { force: true })
  }

  return { createSession, loadSession, listSessions, saveSession, deleteSession }
}

export function trimMessages(messages) {
  const bounded = messages.slice(-MAX_MESSAGES_PER_SESSION)
  return bounded.map((message) => {
    if (!Array.isArray(message.content)) return message
    let hasImage = false
    const content = message.content.map((block) => {
      if (block.type === 'image') {
        hasImage = true
        return { type: 'text', text: '[图片已省略]' }
      }
      return block
    })
    return { ...message, content, hadImage: hasImage || message.hadImage }
  })
}

export function deriveTitle(text) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return null
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX)}…` : clean
}
