#!/usr/bin/env node
import readline from 'node:readline/promises'
import { OpenAIAdapter } from '../engine/adapter/openai'
import { Session } from '../engine/engine'
import { defaultProvider } from '../engine/config'
import type { Hooks } from '../engine/types'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const prov = defaultProvider()
  const adapter = new OpenAIAdapter(prov)
  if (process.argv.includes('--models')) { console.log((await adapter.listModels()).join('\n')); return }
  const prompt = arg('-p')
  const model = arg('--model') ?? 'anthropic/claude-sonnet-5'
  const cwd = arg('--cwd') ?? process.cwd()
  const yes = process.argv.includes('--yes')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const tag = (id: string) => (id === 'main' ? '' : `[${id}] `)
  let lastAgent = 'main'

  const hooks: Hooks = {
    onEvent(e) {
      if (e.kind === 'text') {
        if (e.agentId !== 'main') return
        if (lastAgent !== 'main') { process.stdout.write('\n'); lastAgent = 'main' }
        process.stdout.write(e.text)
      } else if (e.kind === 'tool_start') {
        process.stderr.write(`\n${tag(e.agentId)}▶ ${e.name} ${e.args.slice(0, 160)}\n`); lastAgent = e.agentId
      } else if (e.kind === 'tool_end') {
        process.stderr.write(`${tag(e.agentId)}${e.ok ? '✓' : '✗'} ${e.name}: ${e.output.replace(/\s+/g, ' ').slice(0, 160)}\n`)
      } else if (e.kind === 'agent_start') {
        process.stderr.write(`\n⇢ sub-agent ${e.agentId} (${e.mode}) started\n`)
      } else if (e.kind === 'agent_end' && e.agentId !== 'main') {
        process.stderr.write(`⇠ sub-agent ${e.agentId} ${e.status}\n`)
      } else if (e.kind === 'error') process.stderr.write(`\nERROR: ${e.message}\n`)
    },
    async requestPermission(r) {
      const a = (await rl.question(`\nAllow ${r.kind}: ${r.detail}? [y/N/a=always] `)).trim().toLowerCase()
      return a === 'a' ? 'allow_session' : a === 'y' ? 'allow' : 'deny'
    },
    async askUser(r) {
      return (await rl.question(`\n? ${r.question}${r.choices ? ` (${r.choices.join(' / ')})` : ''}\n> `)).trim()
    }
  }

  const session = new Session({ adapter, hooks, cwd, model, autoApprove: yes })
  process.stderr.write(`model=${model} cwd=${cwd} skills=${session.registry.skills.length} agents=${session.registry.agents.length}\n`)
  process.on('SIGINT', () => { session.stop(); process.exit(130) })
  if (prompt) {
    const r = await session.send(prompt)
    while (session.manager.running() > 0 || session.manager.hasPendingNotifications('main')) {
      await new Promise((res) => setTimeout(res, 500))
      if (session.manager.hasPendingNotifications('main')) await session.send()
    }
    process.stdout.write('\n')
    rl.close()
    process.exit(r.status === 'completed' ? 0 : 1)
  }
  session.onIdleNotification = () => { void session.send() }
  for (;;) {
    const line = await rl.question('\n› ')
    if (!line.trim()) continue
    if (line.trim() === '/exit') break
    await session.send(line)
  }
  rl.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
