import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

export const MCD_MCP_PROXY_PATH = "/api/mcp/mcd"

export type McpToolListItem = {
  name: string
  description?: string
}

export function loadMcdMcpTokenFromStorage(): string {
  if (typeof window === "undefined") return ""
  return window.localStorage.getItem("mcd_mcp_token") ?? ""
}

export function saveMcdMcpTokenToStorage(token: string): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem("mcd_mcp_token", token)
}

export function createMcdMcpClient(): McpClient {
  return new McpClient({ name: "llm-studio-web", version: "0.1.0" })
}

export function createMcdMcpTransport(token: string): StreamableHTTPClientTransport {
  const proxyUrl =
    typeof window !== "undefined"
      ? new URL(MCD_MCP_PROXY_PATH, window.location.origin)
      : new URL(`http://localhost:3000${MCD_MCP_PROXY_PATH}`)

  return new StreamableHTTPClientTransport(proxyUrl, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
  })
}

export function toToolListItems(tools: unknown): McpToolListItem[] {
  const obj = (tools ?? {}) as Record<string, unknown>
  const list = obj.tools
  if (!Array.isArray(list)) return []

  return list.map((t: unknown) => {
    const item = (t ?? {}) as Record<string, unknown>
    return {
      name: typeof item.name === "string" ? item.name : String(item.name ?? ""),
      description: typeof item.description === "string" ? item.description : undefined,
    }
  })
}

export function formatMcpToolResult(result: unknown): string {
  if (!result) return ""

  const obj = result as Record<string, unknown>
  const content = obj.content

  // MCP tool results often look like: { content: [{ type: 'text', text: '...' }, ...] }
  if (Array.isArray(content)) {
    const texts = content
      .map((c) => {
        const part = (c ?? {}) as Record<string, unknown>
        if (part.type === "text" && typeof part.text === "string") return part.text
        if (typeof part.text === "string") return part.text
        return ""
      })
      .filter(Boolean)
    if (texts.length > 0) return texts.join("\n")
  }

  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      window.setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    ),
  ])
}
