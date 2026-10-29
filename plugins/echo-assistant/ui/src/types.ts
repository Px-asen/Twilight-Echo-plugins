export interface Profile {
  id: string; label: string; protocol: string; baseUrl: string; apiKey: string; model: string; vision: boolean; temperature: number
  pricing: { inputPerMillion: number; outputPerMillion: number }
}
export interface Preset { id: string; name: string; systemPrompt: string }
export interface Shortcut { id: string; name: string; text: string }
export interface PromptLibrary { presets: Preset[]; shortcuts: Shortcut[]; defaultPresetId: string }
export interface Prompt { presetId: string; name: string; systemPrompt: string }
export interface Track { id: string; title: string; artist: string; album?: string; duration: number; format: string; sampleRate?: number; bitDepth?: number }
export interface ScanResult {
  scanned: number; libraryTotal: number; complete: boolean; cancelled: boolean; stale: boolean
  libraryRevision?: number; freshnessUnknown?: boolean
  formats?: Record<string, number>; sampleRates?: Record<string, number>; bitDepths?: Record<string, number>
  missingGenre?: number; missingCover?: number; missingBpm?: number; lossless?: number; hiRes?: number
  totalGroups?: number; truncated?: boolean; duplicateGroups?: Array<{ count?: number; keep: Track; duplicates: Track[] }>
}
export interface Report { kind: 'quality' | 'duplicates'; result: ScanResult; createdAt: string }
export interface SessionMessage {
  id: string; role: 'user' | 'assistant' | 'tool'; content: Array<{ type: string; text?: string }>
  toolCalls?: Array<{ id: string; name: string; arguments: string }>; toolCallId?: string; name?: string; implicit?: boolean; interrupted?: boolean; report?: Report
}
export interface Session { id: string; title: string; messages: SessionMessage[]; prompt: Prompt; updatedAt?: string }
export interface SessionSummary { id: string; title: string; updatedAt: string }
export interface ConfirmCard {
  id: string; kind: string; title: string; reason?: string
  preview?: { patch?: Record<string, unknown>; patches?: Array<{ title: string; artist?: string; changes: Record<string, unknown> }>; tracks?: Array<{ title: string; artist?: string }>; total?: number; playlistId?: string }
}
export interface CardEntry { card: ConfirmCard; resolved: boolean; approved?: boolean; cancelled?: boolean }
export interface Run {
  id: string; sessionId: string; kind: 'chat' | 'quality' | 'duplicates'
  phase: 'preparing' | 'generating' | 'tool' | 'confirming' | 'scanning' | 'stopping' | 'done' | 'cancelled' | 'error'
  revision: number; streaming: string; tools: Array<{ id: string; name: string; status: string; error?: string }>; cards: CardEntry[]
  progress: { scanned: number; libraryTotal: number; stale?: boolean } | null; error: string | null; hadWrites: boolean
}
export interface Usage { calls: number; inputTokens: number; outputTokens: number; cost: number }
export interface Snapshot { session: Session; run?: Run | null }
export interface AppSnapshot { profiles: Profile[]; activeProfileId: string | null; sessions: SessionSummary[]; runs: Run[]; promptLibrary: PromptLibrary; promptDefaults: PromptLibrary; usage: Usage }
export const isActive = (run?: Run | null): boolean => !!run && !['done', 'cancelled', 'error'].includes(run.phase)
