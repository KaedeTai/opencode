// Test client for the WebSocket server
// Run: bun run packages/websocket/src/index.ts &
// Then: bun run packages/websocket/src/test.ts

const ws = new WebSocket("ws://localhost:9999/ws")

let receivedCount = 0
ws.onmessage = (e) => {
  receivedCount++
  const msg = JSON.parse(e.data)
  console.log(`[${receivedCount}] ${msg.type}:`, msg.type === "event" ? JSON.stringify(msg.event).slice(0, 100) : msg)

  // After welcome, send a prompt
  if (msg.type === "welcome") {
    console.log("\n📝 Sending test prompt...")
    ws.send(JSON.stringify({ type: "prompt", text: "Say 'hello world'." }))
  }

  // After thinking completes or after timeout, show stats
  if (msg.event?.payload?.type === "session.idle") {
    console.log("\n✅ Session idle, got response!")
    setTimeout(() => {
      ws.close()
      process.exit(0)
    }, 1000)
  }
}

ws.onopen = () => {
  console.log("✅ Connected!")
}

ws.onerror = (e) => {
  console.error("❌ WS Error:", e)
  process.exit(1)
}

ws.onclose = () => {
  console.log("🔌 Disconnected")
  process.exit(0)
}

// Hard timeout
setTimeout(() => {
  console.log(`\n⏰ Timeout: received ${receivedCount} messages`)
  ws.close()
  process.exit(0)
}, 15000)
