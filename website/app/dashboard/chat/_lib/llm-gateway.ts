import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime"

export function tokenNeedsRefresh(expUnix: number, skewSeconds = 300) {
  const now = Math.floor(Date.now() / 1000)
  return expUnix <= now + skewSeconds
}

export async function issueGatewayToken(router: AppRouterInstance) {
  const res = await fetch("/api/llm/token", { method: "POST", credentials: "include" })
  if (!res.ok) {
    if (res.status === 401) {
      router.replace("/login")
      return null
    }
    throw new Error(`failed to issue token: ${res.status}`)
  }

  const json = (await res.json()) as { expires_at_unix: number }
  const exp = Math.floor(json.expires_at_unix)
  return { exp }
}

// Gateway is OpenAI-chat-completions compatible and rejects the non-standard `developer` role.
export function rewriteDeveloperRoleToSystem(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body !== "string") return body
  try {
    const json = JSON.parse(body) as { messages?: Array<Record<string, unknown>> }
    if (!Array.isArray(json.messages)) return body

    json.messages = json.messages.map((msg) => {
      const role = typeof msg.role === "string" ? msg.role : ""
      return {
        ...msg,
        role: role === "developer" ? "system" : role,
      }
    })
    return JSON.stringify(json)
  } catch {
    return body
  }
}
