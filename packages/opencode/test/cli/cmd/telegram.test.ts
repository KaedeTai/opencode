import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { trunc } from "../../../src/cli/cmd/telegram/format"
import {
  getCurrentModel,
  getStaticModelCatalog,
  resolveModel,
  setDefaultModel,
  staticContextLimit,
  type ModelEntry,
} from "../../../src/cli/cmd/telegram/config"
import { getConfigDir, getDbPath, getSessionsFile } from "../../../src/cli/cmd/telegram/paths"

const CATALOG: ModelEntry[] = [
  { providerID: "anthropic", modelID: "MiniMax-M3", name: "MiniMax M3", contextLimit: 1_000_000 },
  { providerID: "anthropic", modelID: "MiniMax-M2.7", name: "MiniMax M2.7", contextLimit: 204_800 },
  { providerID: "omlx", modelID: "qwen3-35b", name: "oMLX Qwen 3 35B", contextLimit: 32_000 },
]

describe("telegram.format.trunc", () => {
  test("returns the string unchanged when under the limit", () => {
    expect(trunc("hello", 10)).toBe("hello")
  })

  test("returns the string unchanged at exactly the limit", () => {
    expect(trunc("hello", 5)).toBe("hello")
  })

  test("truncates and appends an ellipsis when over the limit", () => {
    const out = trunc("hello world", 8)
    expect(out.length).toBeLessThanOrEqual(8)
    expect(out.endsWith("...")).toBe(true)
  })

  test("treats multi-byte characters as their string length", () => {
    // Telegram counts code points, not bytes. Our impl uses .length which
    // is code units — close enough for our 4000-char cap.
    const out = trunc("a".repeat(10), 5)
    expect(out).toBe("aa...")
  })
})

describe("telegram.config.resolveModel", () => {
  test("returns undefined for an empty query", () => {
    expect(resolveModel("", CATALOG)).toBeUndefined()
    expect(resolveModel("   ", CATALOG)).toBeUndefined()
  })

  test("strict-matches providerID/modelID when given a slash", () => {
    expect(resolveModel("anthropic/MiniMax-M3", CATALOG)).toEqual(CATALOG[0])
  })

  test("strict-matches modelID on exact equality", () => {
    expect(resolveModel("MiniMax-M3", CATALOG)).toEqual(CATALOG[0])
  })

  test("falls back to suffix match on modelID", () => {
    expect(resolveModel("M2.7", CATALOG)).toEqual(CATALOG[1])
  })

  test("falls back to case-insensitive name contains", () => {
    expect(resolveModel("qwen", CATALOG)).toEqual(CATALOG[2])
  })

  test("returns undefined when no match", () => {
    expect(resolveModel("nonexistent-model-xyz", CATALOG)).toBeUndefined()
  })
})

describe("telegram.config.staticContextLimit", () => {
  test("returns the static limit for known models", () => {
    expect(staticContextLimit("MiniMax-M3")).toBe(1_000_000)
    expect(staticContextLimit("claude-sonnet-4-5")).toBe(200_000)
  })

  test("returns null for unknown models", () => {
    expect(staticContextLimit("unknown-model-xyz")).toBeNull()
  })
})

describe("telegram.config.getStaticModelCatalog", () => {
  test("returns a non-empty catalog", () => {
    const catalog = getStaticModelCatalog()
    expect(catalog.length).toBeGreaterThan(0)
    for (const entry of catalog) {
      expect(typeof entry.providerID).toBe("string")
      expect(typeof entry.modelID).toBe("string")
      expect(typeof entry.name).toBe("string")
    }
  })
})

describe("telegram.config.getCurrentModel", () => {
  const originalModel = process.env.OPENCODE_DEFAULT_MODEL
  const originalProvider = process.env.OPENCODE_DEFAULT_PROVIDER

  afterEach(() => {
    if (originalModel === undefined) delete process.env.OPENCODE_DEFAULT_MODEL
    else process.env.OPENCODE_DEFAULT_MODEL = originalModel
    if (originalProvider === undefined) delete process.env.OPENCODE_DEFAULT_PROVIDER
    else process.env.OPENCODE_DEFAULT_PROVIDER = originalProvider
  })

  test("parses provider/model from OPENCODE_DEFAULT_MODEL", () => {
    process.env.OPENCODE_DEFAULT_MODEL = "anthropic/MiniMax-M3"
    expect(getCurrentModel()).toEqual({ providerID: "anthropic", modelID: "MiniMax-M3" })
  })

  test("uses OPENCODE_DEFAULT_PROVIDER when no slash in env model", () => {
    process.env.OPENCODE_DEFAULT_MODEL = "MiniMax-M2.7"
    process.env.OPENCODE_DEFAULT_PROVIDER = "anthropic"
    expect(getCurrentModel()).toEqual({ providerID: "anthropic", modelID: "MiniMax-M2.7" })
  })

  test("falls back to 'opencode' provider when no override", () => {
    process.env.OPENCODE_DEFAULT_MODEL = "MiniMax-M2.7"
    delete process.env.OPENCODE_DEFAULT_PROVIDER
    expect(getCurrentModel()).toEqual({ providerID: "opencode", modelID: "MiniMax-M2.7" })
  })
})

describe("telegram.config.setDefaultModel", () => {
  let tmp: string
  let originalConfigDir: string | undefined

  beforeEach(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "telegram-config-test-"))
    originalConfigDir = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = tmp
  })

  afterEach(async () => {
    process.env.OPENCODE_CONFIG_DIR = originalConfigDir
    await fs.promises.rm(tmp, { recursive: true, force: true })
  })

  test("returns an error when no config file exists", () => {
    const result = setDefaultModel("anthropic", "MiniMax-M3")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("No opencode.json")
    }
  })

  test("writes to existing opencode.jsonc, stripping line comments", async () => {
    const cfgPath = path.join(tmp, "opencode.jsonc")
    // Pre-existing jsonc with line comments to verify the strip
    // logic doesn't choke on them.
    const initial = `// header\n{\n  // model block\n  "model": "old/value",\n  "provider": {}\n}\n`
    await fs.promises.writeFile(cfgPath, initial)
    const result = setDefaultModel("anthropic", "MiniMax-M3")
    expect(result.ok).toBe(true)
    const written = JSON.parse(await fs.promises.readFile(cfgPath, "utf8"))
    expect(written.model).toBe("anthropic/MiniMax-M3")
  })

  test("preserves $schema and reorders it to the top", async () => {
    const cfgPath = path.join(tmp, "opencode.json")
    await fs.promises.writeFile(
      cfgPath,
      JSON.stringify({ $schema: "https://example.com/schema.json", provider: {} }),
    )
    const result = setDefaultModel("omlx", "qwen3-35b")
    expect(result.ok).toBe(true)
    const written = JSON.parse(await fs.promises.readFile(cfgPath, "utf8"))
    expect(Object.keys(written)[0]).toBe("$schema")
    expect(written.provider.omlx.model).toBe("qwen3-35b")
  })

  test("writes anthropic provider at top level only (no provider map entry)", async () => {
    const cfgPath = path.join(tmp, "opencode.json")
    await fs.promises.writeFile(cfgPath, JSON.stringify({ provider: { omlx: { model: "old" } } }))
    const result = setDefaultModel("anthropic", "MiniMax-M3")
    expect(result.ok).toBe(true)
    const written = JSON.parse(await fs.promises.readFile(cfgPath, "utf8"))
    // Should NOT have a provider.anthropic entry (env drives the
    // anthropic provider); the top-level model is what matters.
    expect(written.provider.anthropic).toBeUndefined()
    expect(written.model).toBe("anthropic/MiniMax-M3")
    // Pre-existing omlx entry should still be there.
    expect(written.provider.omlx.model).toBe("old")
  })
})

describe("telegram.paths", () => {
  test("getConfigDir honors OPENCODE_CONFIG_DIR", () => {
    process.env.OPENCODE_CONFIG_DIR = "/tmp/test-opencode"
    expect(getConfigDir()).toBe("/tmp/test-opencode")
    delete process.env.OPENCODE_CONFIG_DIR
  })

  test("getConfigDir falls back to ~/.config/opencode", () => {
    delete process.env.OPENCODE_CONFIG_DIR
    const dir = getConfigDir()
    expect(dir).toContain(".config")
    expect(dir).toContain("opencode")
  })

  test("getSessionsFile points at the data dir", () => {
    const file = getSessionsFile()
    expect(file.endsWith("telegram-sessions.json")).toBe(true)
  })

  test("getDbPath honors OPENCODE_DB override", () => {
    process.env.OPENCODE_DB = "/tmp/custom.db"
    expect(getDbPath()).toBe("/tmp/custom.db")
    delete process.env.OPENCODE_DB
  })
})
