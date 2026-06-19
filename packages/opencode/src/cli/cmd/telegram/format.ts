export function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + "..." : s
}

export * as TelegramFormat from "./format"
