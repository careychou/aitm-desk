import { load as yamlLoad } from 'js-yaml'

/** Splits a markdown file into YAML frontmatter (or null) and body. Throws on invalid YAML. */
export function splitFrontmatter(src: string): { data: Record<string, any> | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  if (!m) return { data: null, body: src }
  const data = yamlLoad(m[1])
  return { data: data && typeof data === 'object' ? (data as Record<string, any>) : {}, body: src.slice(m[0].length) }
}
