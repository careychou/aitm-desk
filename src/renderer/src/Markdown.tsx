import { useMemo } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'

const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const l = lang && hljs.getLanguage(lang) ? lang : undefined
      const html = l ? hljs.highlight(text, { language: l }).value : hljs.highlightAuto(text).value
      return `<pre class="code"><code class="hljs">${html}</code></pre>`
    }
  }
})

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noreferrer') }
})

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(md.parse(text) as string), [text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}
