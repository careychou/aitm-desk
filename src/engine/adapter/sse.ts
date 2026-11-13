/** Yields the payload of each `data:` line from an SSE byte stream, stopping at `[DONE]`. */
export async function* parseSSE(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      if (data) yield data
    }
  }
  const tail = buf.trim()
  if (tail.startsWith('data:')) {
    const data = tail.slice(5).trim()
    if (data && data !== '[DONE]') yield data
  }
}
