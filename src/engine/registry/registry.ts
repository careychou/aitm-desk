import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { splitFrontmatter } from './frontmatter'

export interface SkillMeta { name: string; description: string; dir: string; file: string; source: 'project' | 'personal' }
export interface AgentDef { name: string; description: string; tools?: string[]; body: string; file: string; source: 'project' | 'personal' }

export interface Registry {
  skills: SkillMeta[]
  agents: AgentDef[]
  instructions: string
  warnings: string[]
  loadSkill(name: string): { body: string; dir: string } | null
}

const oneLine = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()

function readDirSafe(d: string): fs.Dirent[] {
  try { return fs.readdirSync(d, { withFileTypes: true }) } catch { return [] }
}

export function loadRegistry(opts: { cwd: string; home?: string }): Registry {
  const home = opts.home ?? path.join(os.homedir(), '.copilot')
  const roots: Array<{ base: string; source: 'project' | 'personal' }> = [
    { base: path.join(opts.cwd, '.github'), source: 'project' },
    { base: home, source: 'personal' }
  ]
  const warnings: string[] = []
  const skills = new Map<string, SkillMeta>()
  const agents = new Map<string, AgentDef>()

  for (const { base, source } of roots) {
    for (const ent of readDirSafe(path.join(base, 'skills'))) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue
      const dir = path.join(base, 'skills', ent.name)
      const file = path.join(dir, 'SKILL.md')
      if (!fs.existsSync(file)) continue
      try {
        const { data } = splitFrontmatter(fs.readFileSync(file, 'utf8'))
        if (!data) { warnings.push(`${file}: missing frontmatter`); continue }
        const name = oneLine(data.name) || ent.name
        if (!skills.has(name)) skills.set(name, { name, description: oneLine(data.description), dir, file, source })
      } catch (e: any) {
        warnings.push(`${file}: ${e.message.split('\n')[0]}`)
      }
    }
    for (const ent of readDirSafe(path.join(base, 'agents'))) {
      if (!ent.name.endsWith('.agent.md')) continue
      const file = path.join(base, 'agents', ent.name)
      try {
        const { data, body } = splitFrontmatter(fs.readFileSync(file, 'utf8'))
        const name = oneLine(data?.name) || ent.name.replace(/\.agent\.md$/, '')
        const tools = Array.isArray(data?.tools) ? data!.tools.map(String) : undefined
        if (!agents.has(name)) agents.set(name, { name, description: oneLine(data?.description), tools, body, file, source })
      } catch (e: any) {
        warnings.push(`${file}: ${e.message.split('\n')[0]}`)
      }
    }
  }

  const instructions = [path.join(home, 'copilot-instructions.md'), path.join(opts.cwd, '.github', 'copilot-instructions.md')]
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n\n')

  return {
    skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
    agents: [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)),
    instructions,
    warnings,
    loadSkill(name) {
      const s = skills.get(name)
      if (!s) return null
      return { body: splitFrontmatter(fs.readFileSync(s.file, 'utf8')).body, dir: s.dir }
    }
  }
}
