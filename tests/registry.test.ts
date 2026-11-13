import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { splitFrontmatter } from '../src/engine/registry/frontmatter'
import { loadRegistry } from '../src/engine/registry/registry'

function write(p: string, s: string) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }

let cwd: string, home: string
beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'))
  cwd = path.join(root, 'work'); home = path.join(root, 'home')
  write(`${cwd}/.github/skills/alpha/SKILL.md`, '---\nname: alpha\ndescription: >\n  Alpha skill\n  for tests.\n---\n# Alpha body\nSECRET_BODY')
  write(`${cwd}/.github/skills/broken/SKILL.md`, '---\nname: [unclosed\n---\nbody')
  write(`${cwd}/.github/skills/nofm/SKILL.md`, '# no frontmatter')
  write(`${home}/skills/alpha/SKILL.md`, '---\nname: alpha\ndescription: home alpha\n---\nhome')
  write(`${home}/skills/beta/SKILL.md`, '---\nname: beta\ndescription: Beta\n---\nbeta body')
  write(`${cwd}/.github/agents/rev.agent.md`, '---\nname: reviewer\ndescription: Reviews code\ntools: ["read", "search"]\n---\nYou are a reviewer.')
  write(`${cwd}/.github/agents/st-INDEX.md`, '# index, not an agent')
  write(`${home}/agents/helper.agent.md`, '---\ndescription: Helps\n---\nHelper body')
  write(`${home}/copilot-instructions.md`, 'HOME_INSTR')
  write(`${cwd}/.github/copilot-instructions.md`, 'CWD_INSTR')
})

describe('splitFrontmatter', () => {
  it('parses yaml and body', () => {
    expect(splitFrontmatter('---\na: 1\n---\nbody\n')).toEqual({ data: { a: 1 }, body: 'body\n' })
  })
  it('returns null data without frontmatter', () => {
    expect(splitFrontmatter('hello').data).toBeNull()
  })
})

describe('loadRegistry', () => {
  it('discovers skills with cwd precedence and warns on bad files', () => {
    const r = loadRegistry({ cwd, home })
    const names = r.skills.map((s) => s.name).sort()
    expect(names).toEqual(['alpha', 'beta'])
    expect(r.skills.find((s) => s.name === 'alpha')!.description).toBe('Alpha skill for tests.')
    expect(r.skills.find((s) => s.name === 'alpha')!.source).toBe('project')
    expect(r.warnings.length).toBe(2)
    expect(r.loadSkill('alpha')!.body).toContain('SECRET_BODY')
    expect(r.loadSkill('nope')).toBeNull()
  })
  it('discovers agents with tools and name fallback to filename', () => {
    const r = loadRegistry({ cwd, home })
    const rev = r.agents.find((a) => a.name === 'reviewer')!
    expect(rev.tools).toEqual(['read', 'search'])
    expect(rev.body.trim()).toBe('You are a reviewer.')
    expect(r.agents.find((a) => a.name === 'helper')!.tools).toBeUndefined()
    expect(r.agents.length).toBe(2)
  })
  it('concatenates instructions home then cwd', () => {
    const r = loadRegistry({ cwd, home })
    expect(r.instructions.indexOf('HOME_INSTR')).toBeLessThan(r.instructions.indexOf('CWD_INSTR'))
  })
})
