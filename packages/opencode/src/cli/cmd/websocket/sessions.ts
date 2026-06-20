// Per-WebSocket-client state. Each connected client owns a
// multi-session map (just like the Telegram bot's per-chat
// sessions), and an "active" pointer that the client can
// flip via `switch_session`. Sessions that the server
// created (via `new_session` or auto-create on first
// `prompt`) are tracked here so a reconnecting client
// can resume.

import type { SessionSummary } from "./protocol"

export type ClientSession = {
  id: string
  title: string
  inflight: boolean
  // Last assistant text we streamed, used to dedupe
  // re-emission on reconnect. Optional.
  lastSent?: string
}

export type ClientState = {
  id: string // client id (random uuid)
  // Map sessionId → summary. All sessions created or
  // imported by this client.
  sessions: Map<string, ClientSession>
  // Currently active session, or null when none.
  activeSessionId: string | null
  // Set when a permission.asked event is forwarded. Lets
  // the next inbound permission_reply from this client
  // look up which server-side request it answers without
  // re-asking the server.
  pendingPermission?: {
    permissionId: string
    sessionId: string
  }
  // Same idea for question.asked. Map because the server
  // can group several questions in one event.
  pendingQuestions?: Map<string, { sessionId: string; questionId: string }>
}

export function newClient(id: string): ClientState {
  return {
    id,
    sessions: new Map(),
    activeSessionId: null,
  }
}

export function activeSession(state: ClientState): ClientSession | null {
  if (!state.activeSessionId) return null
  return state.sessions.get(state.activeSessionId) ?? null
}

export function addSession(state: ClientState, session: ClientSession, makeActive = true): void {
  state.sessions.set(session.id, session)
  if (makeActive || !state.activeSessionId) {
    state.activeSessionId = session.id
  }
}

export function setActive(state: ClientState, sessionId: string): void {
  if (state.sessions.has(sessionId)) {
    state.activeSessionId = sessionId
  }
}

export function removeSession(state: ClientState, sessionId: string): void {
  state.sessions.delete(sessionId)
  if (state.activeSessionId === sessionId) {
    const [first] = state.sessions.keys()
    state.activeSessionId = first ?? null
  }
}

export function toSummary(state: ClientState): SessionSummary[] {
  return [...state.sessions.values()].map((s) => ({
    id: s.id,
    title: s.title,
    active: s.id === state.activeSessionId,
    inflight: s.inflight,
  }))
}

export * as WebsocketSessions from "./sessions"
