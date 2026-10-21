/**
 * qq_send_text (proactive plain-text send): the fork-only tool that lets the
 * model push text to a chat without waiting for an inbound message. Covers the
 * happy path (send_msg with a text segment), the empty-text refusal, the
 * chat_id override, the reply_to quoting, and the W2-③ proactive-write gate
 * (minute cap) that sendSegments/sendForward already honor.
 * @module dsh-onebot/tests/send-text
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { ChatBridge } from '../src/bridge.js'
import { registerTools } from '../src/tools.js'

interface SendTool {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** Real ChatBridge + registered qq_* tools over a recording connection stub. */
function makeHarness(config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'send-text-'))
  const calls: Array<{ action: string; params: Record<string, unknown> }> = []
  const bridge = new ChatBridge({
    ctx: new Context(),
    connection: {
      // The outbound pipeline refuses to send while the transport reports
      // disconnected (OneBotNotConnectedError), so the stub must claim a live
      // link — nothing actually reaches the network: call() is recorded only.
      connected: true,
      selfId: '10002',
      call: async (action: string, params: Record<string, unknown>) => {
        calls.push({ action, params })
        return { message_id: 42 }
      },
    } as never,
    media: {} as never,
    transcriber: {} as never,
    agents: {} as never,
    sessions: {} as never,
    agentPresets: undefined as never,
    sessionPersistence: undefined,
    workspaceRegistry: undefined as never,
    agentDefaultModel: undefined,
    defaultModel: undefined,
    config: {
      botQQ: '10002', ignoreSelf: false, requireMention: true,
      interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
      sensitivePatterns: [], mediaDir: join(root, 'media'), maxImageBytes: 8 * 1024 * 1024,
      maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
      textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
      agentPreset: 'standard', workspacePath: join(root, 'ws'), maxInboundFileBytes: 0,
      actionRatePerMinute: 20, actionRatePerDay: 500, actionAuditEnabled: false,
      ...config,
    },
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
    },
    log: () => undefined,
  })
  const ctx = new Context()
  const tools: SendTool[] = []
  ctx.provide('tools' as never, {
    register: (tool: SendTool) => {
      tools.push(tool)
      return () => undefined
    },
  } as never)
  registerTools(ctx, bridge, {} as never, {
    maxImageBytes: 1_000_000,
    maxVoiceBytes: 1_000_000,
    maxFileBytes: 1_000_000,
  })
  const tool = (name: string): SendTool => {
    const found = tools.find(t => t.name === name)
    if (found === undefined) throw new Error('tool not registered: ' + name)
    return found
  }
  const exec = (sessionId: string) => ({ agent: { session: { id: sessionId } } })
  const seed = (sessionId: string, chatId: string): void => {
    ;(bridge as unknown as { bySession: Map<string, string> }).bySession.set(sessionId, chatId)
  }
  const sentText = (): string => {
    const send = calls.filter(c => c.action === 'send_msg').at(-1)
    if (send === undefined) throw new Error('no send_msg recorded')
    const segments = send.params.message as Array<{ type: string; data?: { text?: string } }>
    return segments.map(s => s.data?.text ?? '').join('')
  }
  return { bridge, tool, exec, seed, calls, sentText }
}

describe('qq_send_text (proactive plain text)', () => {
  it('sends text to an explicit chat_id without any inbound message', async () => {
    const h = makeHarness()
    await h.tool('qq_send_text').execute({ text: '主动推送一条', chat_id: 'private:10001' }, h.exec('sess-1'))
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.action).toBe('send_msg')
    expect(h.calls[0]?.params.user_id).toBe(10001)
    expect(h.sentText()).toBe('主动推送一条')
  })

  it('infers the chat from the calling session when chat_id is omitted', async () => {
    const h = makeHarness()
    h.seed('sess-2', 'group:20001')
    await h.tool('qq_send_text').execute({ text: '群里说一句' }, h.exec('sess-2'))
    expect(h.calls[0]?.params.group_id).toBe(20001)
    expect(h.sentText()).toBe('群里说一句')
  })

  it('refuses empty or whitespace-only text without touching the connection', async () => {
    const h = makeHarness()
    await expect(h.tool('qq_send_text').execute({ text: '   ', chat_id: 'private:10001' }, h.exec('s')))
      .rejects.toThrow(/text 必填/)
    expect(h.calls).toHaveLength(0)
  })

  it('quotes the target message when reply_to is given', async () => {
    const h = makeHarness()
    await h.tool('qq_send_text').execute({ text: '回你', chat_id: 'private:10001', reply_to: '555' }, h.exec('s'))
    const segments = h.calls[0]?.params.message as Array<{ type: string; data?: { id?: string } }>
    expect(segments[0]).toMatchObject({ type: 'reply', data: { id: '555' } })
    expect(h.sentText()).toBe('回你')
  })

  it('counts against the proactive-write minute cap (W2-③) and rejects past it', async () => {
    const h = makeHarness({ actionRatePerMinute: 1 })
    await h.tool('qq_send_text').execute({ text: '第一条', chat_id: 'private:10001' }, h.exec('s'))
    await expect(h.tool('qq_send_text').execute({ text: '第二条', chat_id: 'private:10001' }, h.exec('s')))
      .rejects.toThrow(/频率超限|次数超限/)
    expect(h.calls).toHaveLength(1)
  })

  it('is listed among the contributed tools', async () => {
    const h = makeHarness()
    expect(h.tool('qq_send_text')).toBeDefined()
  })
})
