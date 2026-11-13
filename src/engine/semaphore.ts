export class Semaphore {
  private queue: Array<() => void> = []
  private active = 0
  constructor(private max: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const go = () => { signal?.removeEventListener('abort', onAbort); resolve() }
        const onAbort = () => { this.queue = this.queue.filter((q) => q !== go); reject(new Error('aborted')) }
        signal?.addEventListener('abort', onAbort, { once: true })
        this.queue.push(go)
      })
    }
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.queue.shift()?.()
    }
  }
}
