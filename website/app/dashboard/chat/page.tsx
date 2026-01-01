"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { stepCountIs, streamText, tool, type ModelMessage } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"

import {
  createMcdMcpClient,
  createMcdMcpTransport,
  formatMcpToolResult,
  loadMcdMcpTokenFromStorage,
  type McpToolListItem,
  saveMcdMcpTokenToStorage,
  toToolListItems,
  withTimeout,
} from "./_lib/mcd-mcp"
import { issueGatewayToken, rewriteDeveloperRoleToSystem, tokenNeedsRefresh } from "./_lib/llm-gateway"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

type Role = "super_admin" | "admin" | "user"

type MeResponse = {
  user_id: string
  role: Role
  email: string
  github_id?: string | null
  nickname: string
}

type GatewayModel = {
  id: string
  name?: string
  provider?: string
  capabilities?: string[]
}

type ListModelsResponse = {
  data: GatewayModel[]
}

type ChatMessage = {
  id: string
  role: "system" | "user" | "assistant"
  content: string
}

export default function ChatPage() {
  const router = useRouter()

  const gatewayBase =
    process.env.NEXT_PUBLIC_LLM_GATEWAY_HTTP_BASE_URL ?? "http://localhost:8081"

  const [me, setMe] = React.useState<MeResponse | null>(null)
  const [loading, setLoading] = React.useState(true)

  const [models, setModels] = React.useState<GatewayModel[]>([])
  const [model, setModel] = React.useState<string>("")

  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [input, setInput] = React.useState("")
  const [sending, setSending] = React.useState(false)

  const [mcdMcpTokenInput, setMcdMcpTokenInput] = React.useState("")
  const [mcdMcpConnected, setMcdMcpConnected] = React.useState(false)
  const [mcdMcpTools, setMcdMcpTools] = React.useState<McpToolListItem[]>([])
  const [mcdMcpBusy, setMcdMcpBusy] = React.useState(false)

  const tokenExpRef = React.useRef<number>(0)

  const mcdMcpTokenRef = React.useRef<string>("")
  const mcdMcpClientRef = React.useRef<{
    token: string
    client: McpClient
    transport: StreamableHTTPClientTransport
  } | null>(null)

  const canView = Boolean(me)

  function makeId() {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  async function ensureToken(): Promise<void> {
    const exp = tokenExpRef.current
    if (!exp || !Number.isFinite(exp) || tokenNeedsRefresh(exp)) {
      const issued = await issueGatewayToken(router)
      if (!issued) throw new Error("unauthenticated")
      tokenExpRef.current = issued.exp
    }
  }

  function loadMcdMcpToken() {
    const saved = loadMcdMcpTokenFromStorage()
    if (saved) {
      setMcdMcpTokenInput(saved)
      mcdMcpTokenRef.current = saved
    }
  }

  async function closeMcdMcpClient() {
    const existing = mcdMcpClientRef.current
    mcdMcpClientRef.current = null
    setMcdMcpConnected(false)
    setMcdMcpTools([])
    if (!existing) return
    try {
      await existing.transport.terminateSession().catch(() => {})
      await existing.client.close().catch(() => {})
    } catch {
      // ignore
    }
  }

  async function getMcdMcpClient() {
    const token = (mcdMcpTokenRef.current || "").trim()
    if (!token) throw new Error("MCP Token missing. Paste it in the McD MCP section first.")

    const existing = mcdMcpClientRef.current
    if (existing && existing.token === token) {
      // Ensure UI state stays in sync if we already have a live client.
      setMcdMcpConnected(true)
      return existing
    }

    await closeMcdMcpClient()

    const client = createMcdMcpClient()
    const transport = createMcdMcpTransport(token)

    await client.connect(transport)
    const conn = { token, client, transport }
    mcdMcpClientRef.current = conn
    setMcdMcpConnected(true)
    return conn
  }

  async function testMcdMcpConnection() {
    if (mcdMcpBusy) return
    setMcdMcpBusy(true)
    setMcdMcpTools([])
    try {
      const { client } = await getMcdMcpClient()
      const tools = await client.listTools()
      const list = toToolListItems(tools)
      setMcdMcpTools(list)
      toast.success("McD MCP connected")
    } catch (e) {
      await closeMcdMcpClient()
      toast.error(e instanceof Error ? e.message : "Failed to connect to McD MCP")
    } finally {
      setMcdMcpBusy(false)
    }
  }

  async function gatewayFetch(path: string, init?: RequestInit, retry = true) {
    const res = await fetch(`${gatewayBase}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        ...(init?.headers ?? {}),
      },
    })

    if (res.status === 401 && retry) {
      // Cookie token missing/expired; re-issue and retry once.
      tokenExpRef.current = 0
      await ensureToken()
      return gatewayFetch(path, init, false)
    }

    return res
  }

  async function streamChatCompletion(
    nextMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    assistantId: string,
    retry = true
  ) {
    const applyDelta = (delta: string) => {
      if (!delta) return
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + delta } : m))
      )
    }

    const gatewayOpenAI = createOpenAI({
      baseURL: `${gatewayBase}/v1`,
      // Gateway auth is done via HttpOnly cookie. We provide a placeholder key and strip the
      // Authorization header in the custom fetch below.
      apiKey: "cookie",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers)
        headers.delete("authorization")

        const body = rewriteDeveloperRoleToSystem(init?.body)

        const run = () =>
          fetch(input, {
            ...init,
            headers,
            body,
            credentials: "include",
          })

        let res = await run()
        if (res.status === 401 && retry) {
          tokenExpRef.current = 0
          await ensureToken()
          res = await run()
        }
        return res
      },
    })

    const coreMessages: ModelMessage[] = nextMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }))

    const systemPrompt: ModelMessage = {
      role: "system",
      content:
        "You are a helpful assistant. If the user asks about McDonald's China promotions, calendars, or coupons, you MUST use the available mcd_* tools to fetch real data and then summarize it for the user in plain Chinese. Do not say you are fetching data unless you actually call a tool.",
    }

    const modelMessages: ModelMessage[] =
      coreMessages.length > 0 && coreMessages[0]?.role === "system"
        ? coreMessages
        : [systemPrompt, ...coreMessages]

    const mcdMcpToolsEnabled = Boolean((mcdMcpTokenRef.current || "").trim())

    const callMcdTool = async (name: string, args: Record<string, unknown>) => {
      const { client } = await getMcdMcpClient()
      const res = await withTimeout(client.callTool({ name, arguments: args }), 20_000)
      // Return both a readable summary and the raw object for transparency.
      return {
        text: formatMcpToolResult(res),
        raw: res,
      }
    }

    const tools = mcdMcpToolsEnabled
      ? {
          mcd_campaign_calendar: tool({
            description:
              "查询麦当劳中国活动日历。可传 specifiedDate(yyyy-MM-dd) 查询指定日期附近三天。",
            inputSchema: z
              .object({
                specifiedDate: z
                  .string()
                  .regex(/^\d{4}-\d{2}-\d{2}$/)
                  .optional()
                  .describe("yyyy-MM-dd，可选"),
              })
              .strict(),
            execute: async ({ specifiedDate }) => {
              return callMcdTool(
                "campaign-calender",
                specifiedDate ? { specifiedDate } : {}
              )
            },
          }),
          mcd_available_coupons: tool({
            description: "查询用户当前可领取的麦麦省优惠券列表。",
            inputSchema: z.object({}).strict(),
            execute: async () => {
              return callMcdTool("available-coupons", {})
            },
          }),
          mcd_auto_bind_coupons: tool({
            description: "一键领取麦麦省所有当前可领取的优惠券。",
            inputSchema: z.object({}).strict(),
            execute: async () => {
              return callMcdTool("auto-bind-coupons", {})
            },
          }),
          mcd_my_coupons: tool({
            description: "查询我的优惠券列表（可用券）。",
            inputSchema: z.object({}).strict(),
            execute: async () => {
              return callMcdTool("my-coupons", {})
            },
          }),
          mcd_now_time_info: tool({
            description: "获取当前时间信息，便于后续按日期查询。",
            inputSchema: z.object({}).strict(),
            execute: async () => {
              return callMcdTool("now-time-info", {})
            },
          }),
        }
      : undefined

    try {
      const mainAbort = new AbortController()
      const mainAbortId = window.setTimeout(() => mainAbort.abort(), 120_000)

      const result = streamText({
        model: gatewayOpenAI.chat(model),
        messages: modelMessages,
        providerOptions: {
          openai: {
            systemMessageMode: "system",
          },
        },
        tools,
        stopWhen: stepCountIs(5),
        abortSignal: mainAbort.signal,
      })

      let sawAnyText = false
      try {
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            sawAnyText = true
            applyDelta(part.text)
          }

          if (part.type === "tool-call") {
            console.info("[tool-call]", {
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              input: part.input,
            })
          }

          if (part.type === "tool-result") {
            const out = (part.output ?? {}) as Record<string, unknown>
            const text = typeof out.text === "string" ? out.text : formatMcpToolResult(part.output)
            console.info("[tool-result]", {
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              output: part.output,
              text,
            })
          }

          if (part.type === "tool-error") {
            const anyPart = part as unknown as Record<string, unknown>
            const errVal = anyPart.error
            const errMsg =
              typeof errVal === "string"
                ? errVal
                : errVal && typeof errVal === "object" && "message" in errVal
                  ? String((errVal as { message?: unknown }).message ?? "")
                  : ""
            console.error("[tool-error]", {
              toolName: (anyPart.toolName as string | undefined) ?? "(unknown)",
              toolCallId: (anyPart.toolCallId as string | undefined) ?? "(unknown)",
              error: errVal,
              message: errMsg,
            })
          }
        }
      } finally {
        window.clearTimeout(mainAbortId)
      }

      if (!sawAnyText) {
        console.warn("[streamText] finished with no text output")
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      throw new Error(message || "chat failed")
    }
  }

  async function load() {
    setLoading(true)
    try {
      const meRes = await fetch("/api/me", { credentials: "include" })
      if (!meRes.ok) {
        router.replace("/login")
        return
      }
      const meJson = (await meRes.json()) as MeResponse
      setMe(meJson)

      await ensureToken()

      const modelsRes = await gatewayFetch("/v1/models")
      if (!modelsRes.ok) {
        throw new Error(`failed to load models: ${modelsRes.status}`)
      }
      const json = (await modelsRes.json()) as ListModelsResponse
      const items = json.data ?? []
      setModels(items)
      setModel((prev) => prev || items[0]?.id || "")

      if (items.length === 0) {
        toast.message("No models available", {
          description: "Ask an admin to configure providers/models in /dashboard/llm.",
        })
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  React.useEffect(() => {
    void load()
    loadMcdMcpToken()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    const id = window.setInterval(() => {
      const exp = tokenExpRef.current
      if (exp && Number.isFinite(exp) && tokenNeedsRefresh(exp, 600)) {
        void issueGatewayToken(router)
          .then((issued: { exp: number } | null) => {
            if (issued) tokenExpRef.current = issued.exp
          })
          .catch(() => {})
      }
    }, 60_000)
    return () => window.clearInterval(id)
  }, [router])

  async function send() {
    const text = input.trim()
    if (!text) return
    if (!model) {
      toast.error("No model selected")
      return
    }

    if (sending) return
    setInput("")
    setSending(true)

    const userId = makeId()
    const assistantId = makeId()

    const nextMessages = [...messages, { id: userId, role: "user", content: text } as const]
    setMessages([...nextMessages, { id: assistantId, role: "assistant", content: "" }])

    try {
      await ensureToken()
      // keep latest token for agent tool calls
      mcdMcpTokenRef.current = (mcdMcpTokenInput || "").trim()
      await streamChatCompletion(
        nextMessages.map((m) => ({ role: m.role, content: m.content })),
        assistantId
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Chat failed"
      toast.error(msg)
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, content: m.content || `Error: ${msg}` } : m))
      )
    } finally {
      setSending(false)
    }
  }

  if (!canView && me) return null

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" />
      <SidebarInset>
        <SiteHeader />
        <div className="flex flex-1 flex-col">
          <div className="@container/main flex flex-1 flex-col gap-2">
            <div className="flex items-center justify-between gap-4 px-4 py-4 md:px-6">
              <div>
                <div className="text-lg font-semibold">Chat</div>
                <div className="text-muted-foreground text-sm">
                  Streams from the browser using Vercel AI SDK to llm-gateway-http (OpenAI-compatible /v1).
                </div>
              </div>
              <Button variant="outline" onClick={() => void load()} disabled={loading}>
                Refresh
              </Button>
            </div>

            <div className="px-4 pb-6 md:px-6">
              <Tabs defaultValue="chat">
                <TabsList>
                  <TabsTrigger value="chat">Chat</TabsTrigger>
                  <TabsTrigger value="models">Models</TabsTrigger>
                </TabsList>

                <TabsContent value="chat" className="mt-4">
                  <div className="space-y-4 rounded-lg border p-4">
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="chat-model">Model</Label>
                        <select
                          id="chat-model"
                          className="border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-sm"
                          value={model}
                          onChange={(e) => setModel(e.target.value)}
                          disabled={loading || sending}
                        >
                          {models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.id}
                            </option>
                          ))}
                          {!loading && models.length === 0 && <option value="">(no models)</option>}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label>Gateway</Label>
                        <Input value={gatewayBase} readOnly />
                      </div>
                    </div>

                    <div className="space-y-2 rounded-md border p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium">McD MCP</div>
                          <div className="text-muted-foreground text-xs">
                            Streamable HTTP: https://mcp.mcd.cn/mcp-servers/mcd-mcp
                          </div>
                        </div>
                        <div className="text-xs">
                          {(() => {
                            const hasToken = Boolean(mcdMcpTokenInput.trim())
                            const label = mcdMcpBusy
                              ? "connecting…"
                              : mcdMcpConnected
                                ? "connected"
                                : hasToken
                                  ? "configured"
                                  : "not configured"
                            const color = mcdMcpBusy
                              ? "text-amber-600"
                              : mcdMcpConnected
                                ? "text-emerald-600"
                                : hasToken
                                  ? "text-sky-600"
                                  : "text-muted-foreground"
                            return <span className={color}>{label}</span>
                          })()}
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <Input
                          value={mcdMcpTokenInput}
                          onChange={(e) => setMcdMcpTokenInput(e.target.value)}
                          placeholder="Paste YOUR_MCP_TOKEN"
                          disabled={loading || sending || mcdMcpBusy}
                        />
                        <Button
                          variant="outline"
                          disabled={loading || sending || mcdMcpBusy || !mcdMcpTokenInput.trim()}
                          onClick={() => {
                            const t = mcdMcpTokenInput.trim()
                            mcdMcpTokenRef.current = t
                            saveMcdMcpTokenToStorage(t)
                            void closeMcdMcpClient()
                            toast.success("MCP token saved")
                          }}
                        >
                          Save
                        </Button>
                        <Button
                          variant="outline"
                          disabled={loading || sending || mcdMcpBusy || !mcdMcpTokenInput.trim()}
                          onClick={() => void testMcdMcpConnection()}
                        >
                          Test
                        </Button>
                        <Button
                          variant="outline"
                          disabled={loading || sending || mcdMcpBusy}
                          onClick={() => void closeMcdMcpClient()}
                        >
                          Disconnect
                        </Button>
                      </div>

                      {mcdMcpTools.length > 0 && (
                        <div className="text-xs text-muted-foreground">
                          Tools: {mcdMcpTools.map((t) => t.name).join(", ")}
                        </div>
                      )}
                    </div>

                    <div className="h-105 overflow-auto rounded-md border p-3 text-sm">
                      {messages.length === 0 && (
                        <div className="text-muted-foreground">Send a message to start.</div>
                      )}
                      <div className="space-y-3">
                        {messages.map((m) => (
                          <div key={m.id} className="space-y-1">
                            <div className="text-muted-foreground text-xs">{m.role}</div>
                            <div className="whitespace-pre-wrap">{m.content || (m.role === "assistant" ? "…" : "")}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <Input
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="Type a message..."
                        disabled={loading || sending || models.length === 0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault()
                            void send()
                          }
                        }}
                      />
                      <Button onClick={() => void send()} disabled={loading || sending || !input.trim()}>
                        Send
                      </Button>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="models" className="mt-4">
                  <div className="space-y-2 rounded-lg border p-4 text-sm">
                    <div className="text-muted-foreground">Available models from llm-gateway-http:</div>
                    <ul className="list-disc space-y-1 pl-5">
                      {models.map((m) => (
                        <li key={m.id}>
                          <span className="font-medium">{m.id}</span>
                          {m.provider ? ` (${m.provider})` : ""}
                        </li>
                      ))}
                      {!loading && models.length === 0 && <li>(none)</li>}
                    </ul>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
