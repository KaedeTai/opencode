// Wire protocol for the opencode WebSocket bridge. Anything
// that crosses the socket boundary is defined here so the
// client (browser, mobile, native app) has one place to
// look for the schema.
//
// Conventions:
// - All messages are JSON objects with a `type` field.
// - Client → Server messages are commands (imperative).
// - Server → Client messages are either events (forwarded
//   from opencode's own SSE stream) or responses to a
//   command.
// - Errors are sent as `{ type: "error", code, message }`
//   with a stable `code` the client can switch on.

// ── Client → Server ────────────────────────────────────────
export type ClientMessage =
  | { type: "new_session"; title?: string }
  | { type: "list_sessions" }
  | { type: "switch_session"; sessionId: string }
  | { type: "close_session"; sessionId: string }
  | { type: "prompt"; sessionId?: string; text: string; attachments?: Attachment[] }
  | { type: "abort"; sessionId?: string }
  | { type: "permission_reply"; permissionId: string; response: "once" | "always" | "reject" }
  | { type: "question_reply"; questionId: string; answers: string[][] }
  | { type: "ping" }

export type Attachment = {
  mime: string
  data: string // base64 (no data: prefix)
  filename?: string
}

// ── Server → Client ────────────────────────────────────────
export type ServerMessage =
  | { type: "welcome"; version: string; serverUrl: string; reconnect?: boolean }
  | { type: "pong" }
  | { type: "event"; event: unknown }
  | { type: "session_created"; sessionId: string; title: string; active: boolean }
  | { type: "session_switched"; sessionId: string }
  | { type: "session_closed"; sessionId: string }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "prompt_accepted"; sessionId: string }
  | { type: "prompt_rejected"; sessionId: string; reason: string }
  | { type: "aborted"; sessionId: string }
  | { type: "error"; code: ErrorCode; message: string; sessionId?: string }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string }

export type SessionSummary = {
  id: string
  title: string
  active: boolean
  inflight: boolean
}

export type ErrorCode =
  | "invalid_message"
  | "session_not_found"
  | "session_create_failed"
  | "prompt_failed"
  | "internal"
