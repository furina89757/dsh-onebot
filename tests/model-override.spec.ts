/**
 * Channel-level model override (fork-only): provider/model/reasoningEffort in
 * the plugin config take precedence over the deployment default for QQ
 * sessions, so a QQ bot can run a different model than the desktop sessions.
 * Also pins the /model effort-preservation fix.
 * @module dsh-onebot/tests/model-override
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { ChatBridge } from '../src/bridge.js'

/** Build a bridge whose defaultModel reports the given deployment selection. */
function makeBridge(opts: {
  channel?: { provider?: string; model?: string; reasoningEffort?: string }
  deployment?: { provider: string; model: string; reasoningEffort?: string }
}) {
  const root = mkdtempSync(join(tmpdir(), 'model-override-'))
  const bridge = new ChatBridge({
    ctx: new Context(),
    connection: { connected: true, selfId: '10002', call: async () => ({ message_id: 1 }) } as never,
    media: {} as never,
    transcriber: {} as never,
    agents: {} as never,
    sessions: {} as never,
    agentPresets: undefined as never,
    sessionPersistence: undefined,
    workspaceRegistry: undefined as never,
    agentDefaultModel: undefined,
    defaultModel: opts.deployment === undefined ? undefined : () => opts.deployment,
    config: {
      botQQ: '10002', ignoreSelf: false, requireMention: true,
      interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
      sensitivePatterns: [], mediaDir: join(root, 'media'), maxImageBytes: 8 * 1024 * 1024,
      maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
      textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
      agentPreset: 'standard', workspacePath: join(root, 'ws'), maxInboundFileBytes: 0,
      actionRatePerMinute: 20, actionRatePerDay: 500, actionAuditEnabled: false,
      provider: opts.channel?.provider ?? '',
      model: opts.channel?.model ?? '',
      reasoningEffort: opts.channel?.reasoningEffort ?? '',
    },
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
    },
    log: () => undefined,
  })
  // modelWiring is private; read it through the structural escape hatch the
  // existing registry tests use.
  const registry = (bridge as unknown as { registry: { modelWiring(): { agentOptions: { provider?: string; model?: string }; selectionRef: { current?: { provider: string; model: string; reasoningEffort?: string } } | undefined } } }).registry
  return { bridge, wiring: () => registry.modelWiring() }
}

describe('channel-level model override', () => {
  it('uses the channel provider/model/effort when all are configured', () => {
    const h = makeBridge({
      channel: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
      deployment: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'max' },
    })
    const w = h.wiring()
    expect(w.agentOptions).toEqual({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' })
    expect(w.selectionRef?.current).toEqual({
      provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high',
    })
  })

  it('falls back to the deployment default when the channel pair is empty', () => {
    const h = makeBridge({
      channel: {},
      deployment: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'max' },
    })
    expect(h.wiring().agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(h.wiring().selectionRef?.current).toEqual({
      provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'max',
    })
  })

  it('ignores a half-configured channel pair (provider without model)', () => {
    const h = makeBridge({
      channel: { provider: 'workbuddy' },
      deployment: { provider: 'deepseek-official', model: 'deepseek-chat' },
    })
    expect(h.wiring().agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
  })

  it('omits reasoningEffort from the channel selection when it is empty', () => {
    const h = makeBridge({
      channel: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      deployment: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'max' },
    })
    expect(h.wiring().selectionRef?.current).toEqual({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' })
    expect(h.wiring().selectionRef?.current?.reasoningEffort).toBeUndefined()
  })

  it('yields no selection when neither channel nor deployment configures one', () => {
    const h = makeBridge({ channel: {} })
    expect(h.wiring().agentOptions).toEqual({})
    expect(h.wiring().selectionRef).toBeUndefined()
  })
})
