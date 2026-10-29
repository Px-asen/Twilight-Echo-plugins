import type { PluginEvent } from './bridge'
import type { Run, Session, SessionMessage, Snapshot, CardEntry } from './types'

/** Ordered snapshots prevent late acknowledgements resurrecting a reply. */
export class ConversationStore {
  sessions = new Map<string, Session>()
  runs = new Map<string, Run>()
  private retired = new Set<string>()
  hydrate({ session, run }: Snapshot): void {
    const current = this.runs.get(session.id)
    if (run && !this.accept(run)) return
    if (!run && current) return
    this.sessions.set(session.id, session)
    if (run) this.runs.set(session.id, run)
  }
  private accept(run: Run): boolean {
    if (this.retired.has(run.id)) return false
    const current = this.runs.get(run.sessionId)
    if (current?.id === run.id) return run.revision >= current.revision
    if (current) this.retired.add(current.id)
    return true
  }
  snapshot(run: Run): void { if (this.accept(run)) this.runs.set(run.sessionId, run) }
  event(event: PluginEvent): void {
    const id = event.sessionId
    if (!id || !event.runId || this.retired.has(event.runId)) return
    let run = this.runs.get(id)
    if (run?.id !== event.runId) {
      if (event.type !== 'start') return
      if (run) this.retired.add(run.id)
      run = { id: event.runId, sessionId: id, kind: event.kind as Run['kind'], phase: 'preparing', revision: 0, streaming: '', tools: [], cards: [], progress: null, error: null, hadWrites: false }
      this.runs.set(id, run)
    }
    if (Number(event.revision) <= run.revision) return
    run.revision = Number(event.revision)
    switch (event.type) {
      case 'start': {
        const session = this.sessions.get(id), message = event.message as SessionMessage | undefined
        if (session) {
          if (event.title) session.title = String(event.title)
          if (message && !session.messages.some(item => item.id === message.id)) session.messages.push(message)
        }
        break
      }
      case 'step': run.phase = 'generating'; run.streaming = ''; break
      case 'delta': run.phase = 'generating'; run.streaming += String(event.text ?? ''); break
      case 'tool': {
        run.phase = 'tool'
        let tool = run.tools.find(item => item.id === event.id)
        if (!tool) { tool = { id: String(event.id), name: String(event.name), status: 'start' }; run.tools.push(tool) }
        tool.status = String(event.status); tool.error = event.error ? String(event.error) : undefined
        break
      }
      case 'card': run.phase = 'confirming'; run.cards.push({ card: event.card as CardEntry['card'], resolved: false }); break
      case 'card-resolved': {
        const card = run.cards.find(item => item.card.id === event.cardId)
        if (card) Object.assign(card, { resolved: true, approved: event.approved === true, cancelled: event.cancelled === true })
        run.phase = run.phase === 'stopping' ? 'stopping' : 'tool'
        break
      }
      case 'progress': run.phase = 'scanning'; run.progress = event.progress as Run['progress']; break
      case 'message': {
        const session = this.sessions.get(id)
        const message = event.message as SessionMessage
        if (session && !session.messages.some(item => item.id === message.id)) session.messages.push(message)
        if (message.role === 'assistant') run.streaming = ''
        break
      }
      case 'done': this.runs.set(id, event.run as Run); this.sessions.set(id, event.session as Session); break
    }
  }
}
