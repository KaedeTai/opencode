import { describe, expect, test } from "bun:test"
import {
  activeSession,
  addSession,
  newClient,
  removeSession,
  setActive,
  toSummary,
} from "../../../src/cli/cmd/websocket/sessions"

const make = () => newClient("c1")

describe("websocket.sessions", () => {
  test("newClient starts with no sessions and no active", () => {
    const c = make()
    expect(c.id).toBe("c1")
    expect(c.sessions.size).toBe(0)
    expect(c.activeSessionId).toBeNull()
    expect(activeSession(c)).toBeNull()
  })

  test("addSession inserts and makes the new session active by default", () => {
    const c = make()
    addSession(c, { id: "s1", title: "first", inflight: false })
    expect(c.sessions.size).toBe(1)
    expect(c.activeSessionId).toBe("s1")
    expect(activeSession(c)?.id).toBe("s1")
  })

  test("addSession with makeActive=false keeps the previous active", () => {
    const c = make()
    addSession(c, { id: "s1", title: "first", inflight: false })
    addSession(c, { id: "s2", title: "second", inflight: false }, false)
    expect(c.activeSessionId).toBe("s1")
    expect(c.sessions.size).toBe(2)
  })

  test("setActive flips the active id when the target exists", () => {
    const c = make()
    addSession(c, { id: "s1", title: "first", inflight: false })
    addSession(c, { id: "s2", title: "second", inflight: false })
    setActive(c, "s2")
    expect(c.activeSessionId).toBe("s2")
  })

  test("setActive is a no-op when the target doesn't exist", () => {
    const c = make()
    addSession(c, { id: "s1", title: "first", inflight: false })
    setActive(c, "nope")
    expect(c.activeSessionId).toBe("s1")
  })

  test("removeSession drops it and promotes the next one if it was active", () => {
    const c = make()
    addSession(c, { id: "s1", title: "first", inflight: false })
    addSession(c, { id: "s2", title: "second", inflight: false })
    removeSession(c, "s1")
    expect(c.sessions.size).toBe(1)
    // s1 was active; removeSession promotes the next one.
    expect(c.activeSessionId).toBe("s2")
  })

  test("removeSession leaves active null when removing the last session", () => {
    const c = make()
    addSession(c, { id: "s1", title: "first", inflight: false })
    removeSession(c, "s1")
    expect(c.sessions.size).toBe(0)
    expect(c.activeSessionId).toBeNull()
  })

  test("toSummary projects the public shape with active/inflight flags", () => {
    const c = make()
    addSession(c, { id: "s1", title: "first", inflight: true })
    addSession(c, { id: "s2", title: "second", inflight: false })
    const summary = toSummary(c)
    expect(summary).toHaveLength(2)
    const byId = Object.fromEntries(summary.map((s) => [s.id, s]))
    expect(byId.s1).toEqual({ id: "s1", title: "first", active: false, inflight: true })
    expect(byId.s2).toEqual({ id: "s2", title: "second", active: true, inflight: false })
  })
})
