import { previewMessage, sampleJob, sampleSettings } from './fixtures'

// Exact packaged icon bytes; embedding keeps this preview entirely offline.
const previewIcon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAN7UlEQVR42u3dW1oiSxaG4ZpGTUMQoWnAU/dV3WwR5NzQnAWxZ1DjcBo1DmegctDtOOjAyMjKiIy1ViRKkkElz/ON4H93bcXMiG9//fv921//+hvtSu1Srkh0veniDawEdc4rG3Sz6ewVrAJ1yqsS1bwVVr7qWHleg6jpLbf01SL6zz/x2prEyN+hrtQu5YpE15su3sBKUOe8skE3m85ewSpQp7wqUc1bYeWrjpXnNYia3nJLXy0iNjBaW1d2IQFIqF2pXcoVia43XbyBlaDOeWWDbjadvYJVoE55VaKat8LKVx0rz2sQNb3llr5aRGxgtLau7EIL4IfoSu1Srkh0veniDawEdc4rG3Sz6ewVrAJ1yqsS1bwVVr7qWHleg6jpLbf01SJiA6O1dWUXKIDBldqlXJHoetPFG1gJ6pxXNuhm09krWAXqlFclqnkrrHzVsfK8BlHTW27pq0XEBkZr68oucADO6D/dLuWKRNebLt7ASlDnvLJBN5vOXsEqUKe8KlHNW2Hlq46V5zWImt5yS18tIjYwWltXdiEB6KgArmQAD2xwqSLR9aaLN7AS1DmvbNDNprNXsArUKa9KVPNWWPmqY+V5DaKmt9zSV4uIDYzW1pVdSAA6KoArFQAf/ZeoSHS96eINrAR1zisbdLPp7BWsAnXKqxLVvBVWvupYeV6DqOktt/TVImIDo7V1ZRcSgI4K4EoFcCkBeCwSXW+6eAMrQZ3zygbdbDp7BatAnfKqRDVvhZWvOlae1yBqesstfbWI2MBobV3ZhQSgowK4UgFcygCckd+hrjddvIGVoM55ZYNuNp29glWgTnlVopq3wspXHSvPaxA1veWWvlpEbGC0tq7sQgLQIQFcygCKMoC12vWmizewEtQ5r2zQzaazV7AK1CmvSlTzVlj5qmPleQ2iprfc0leLiA2M1taVXUgAOiSASxlAkQAQjx/p8SUAHRLApQygSACIx4/8+C6ADgngUgZQJADE41sx/geADgHgv/9QABQJAPH41oy/7hAA2PgygCIBIB7fqvFRAGx4GUCRAOD8qhePb8/4IAA2ugygSABwvuR5j8e3anwtADZ4MADO17sggHj8yI7vA8DGDgbA+cMOCCAeP9LjSwDY0MEAOH/SBQHE40d+fBcAGzkYAOdhDhBAPL4V438AYAOjALoqAOcxLhBAPL4146/ZwCiArgrAeYATBBCPb9X4KICuCsB5dBsEUIIAxONHdXwQQFcF4Ly0AQIoQQDi8aM8vhZAVwuAv52jBVCCAMTjR318H4CuDkBmDgMoQQDi8W0YXwLQ1QHIzGEAJQhAPL4t47sAujoAmTkMoAQBiMe3afwPAF0dgMzcBdBTAZQgAPwBznh8e8Zfd3UAMnMXQE8FUIIA8Ee33+PxrRrfDyAzdwH0VAAlCAB/aeOxbAAgHj9S48sAMnMXQE8FUIIA8Ne1fpUNANg6vvgc4Pi/AWTmLoCeMQD+ouZD2QCAzf/li88Bjs8BZOYugJ4xAP6K9s+yAYBDGF9CcDjjr9noLoCeMQB+OMOgbADgkMZ3ERzO+C6AnjEAfizLj7IBANt/4DMBYPn4HwB6BIC+C4AfyJQoGwA41PG9CA5g/HWPANB3AfCj2L6XDQAcwq961OdAxkcB9AWAtAOgbADgTxifQmDR+CCAvgCQdgCUDQA47+db/yXPZwBYNr4WQF8ASAcA4JzM8f6njK9DYOH4PgB9ASAdAIBzJg8I4FDH9yKwdHwJQF8ASAcA4JzGBQKw6bv9bT8Wj+8C6AsA6QAAnHP4QACHMr74J34bBBEf/wNAXwBIBwDgnMAJArDtr3q7AGDB+Ou+AJCGAQxUAM7ZuyCAQxrfFICKwJLxOYA0DGCgAnBO3QYB2Pj3/CC/6pkAsGj8NRsZBDBQATjn7YMAKhAAS8cPCmDzsWx8EMBABeDctAECqEAADmh88V94IATRHl8LYKAFwK9U0QKoQAAi/hjXtl/yGAOI/vg+AAMdgJMXGEAFAmD5+F4A6k/3Jh9LxpcADHQATl5gABUIgAUPcG47vvG/AnaM7wIY6ACcvMAAKhCAAxjf5Otd038FIj7+B4CBDsDJiwtgqAKoQAD4qduRf3T7q77bpz4WjL8e6ACcvLgAhiqACgSAn7f/btuXPGF/Ija+H8DJiwtgqAKoQAD4TRuPVQJAFH/V2weACI0vAzh5cQEMVQAVCAC/Y+dXlQAQ5Z/2w/xEbPzfAE5eXABDYwD8dq2HKgEg6j/wRQXAHsbnAE5eXABDYwD8Xr2fVQJA1H/giwqAPY2/ZqO7AIbGAPiNmoMqASAKL2raAGCP47sAhsYA+F26P6oEgKi8pRt1AHse/wPAkAAwcgHwW7QTVQJAlF7RjjKACIy/HhIARi6AUw6gSgCIxzdDEJHxUQAjASDlAKgSAGpeABE4nCGqnwiNDwIYCQApB0CVAFDzAojHD4Zgf+NrAYwEgJQhgJoXQESOZbEGwH7H9wEYCQApQwA1LwB+hapV43/1M3yBEOx/fAnASABIGQKoeQHwy5Pfo3AgU5DPVz/Dtw2APY7vAhgJAClDADUvAH5tugTAhvG1AD75JE/Qz57H/wAwEgBSegBjFUDNC6Cw8gH4U8f/agQhjL8eCQApPYCxCqDmBVBY+QDs8xy+TwH4wmf4vgJASONzACk9gLEKoOYFUFj5ANQxAH/I+OJLns8gCHH8NRtaC2CsAqh5ARRWPgB1DEAIJ3BuDWBHT+9uCyDk8bUAxiiAwsoHoI4BiOD4LoAdPrq9zWcP4/sAjFEAhZUPQB0DENLZu1Ebf1sEexhfAjBGARRWPgB1DECIBy8HBhDSSxtb/SsQ7vgugDEG4PjZD6COAQj51O0oji/6CgA7HP8DwBgDcPz8/VYFUMcA7OHI9W0BhPHc/mcB7Hj89RgDcPycuFUB1DEAeQ4g7PP2twEQ1ksbnwEQwvgwgOPnH7cqgDoGIM8B7OOyhaiOvw2CkMfXAzh+HtyqAOoYgDwH0CAA7Oq8/SAA9vG6VlAAIY7vB3D8/PM2EIA8B9AgAOzysgUbXtQ0/YQ8vgzg+PnhNhCAPAfQIADs+qaNIO/k7etFza0B7Hb83wCOn3/dBgKQ5wAaBIAwrln5LIAwXtfaCsDux+cAjp8fbwMByHMADQJAWHfsRH188Q1fIADhjL9m47/fBgKQ5wAaBIAwL1jaFkDYL2oaAwhv/PWtAYCJCyDPATQIAGHfrmXD+KYIQh6fBDBxAeQ5gAYBYB9XqwUFsM9XtE0BhDQ+CmAiACQdAA0CQNMLIMSr1YIA2Pf7+SYAQhwfBDARAJIOgAYBoOkFEPK9eraML77kwT4hj68FMBEAkoYAml4Ae7hU0QRAlE7m2BbADsb3AZgIAElDAE0vgNzyfR+XKto0PoUg5PElABMBIGkIoOkFkFv6AIR1tZolp3FtDWCH47sAJgJA0hBA0wsgt/QBCPNePUtO45K+5DEFsOPxPwBMBICkHsBUBdD0AsgtfQDCvlTRtvFFFIAQxl9PBICkHsBUBdD0AsgtfQD2caOmBUexab/hwwCEND4HkNQDmKoAml4AuaUPQIsAYPntWvt6bn+X46/Z0FoAUxVA0wsgt/QBaBEA4vEjOb4WwBQFkFv6ALQIAPH4kR3fB2CKAsgtfQBaBIB4/EiPLwGYogBySx+AFgEgHj/y47sAphiAxJMfQIsAEI9vxfgfAKYYgMTT9zsVQIsAEI9vzfjrKQYg8ZS4UwG0CADx+FaNDwNIPP24UwG0CABs4Pd4fKvG1wNIPA3uVAAtAgAbGAUQjx/J8f0AEk8/74ICYAOjAOLxIzu+DCDx9HAXFAAbGAUQjx/p8X8DSDz9ugsKgA2MAojHj/z4HEDi6fEuKAA2MAogHt+K8dds/Pc7AsBMBcAGRgHE41sz/vqOADBTAbCBUQDx+FaNjwKYqQDYwCiAtg5APH6UxwcBzFQAbGAUQFsHIB4/6uNrAcxUAEcEgLYOQDy+DeP7AMxUAEcEgLYOQDy+LeNLAGYqgCMCQFsHILuQ6hCxgdG6ujJztx5RX5SGG+jiFyq+O/fqoY1EKX1jLP5cPtlElNQ3xeIjYz3OVABHBIC2DkB2IdUhYgOjdXVl5m49or4oDTfQxa9SfXRu1EQbiVL6xlj8jRyyiSipb4rF/+tGm6kAjmQA9yqAtg5AdiHVIWIDo3V1ZeZuPaK+KA030MUvUf7l3KWLNhKl9I2x+Lt4ZBNRUt8Ui/9/HW0m98AGlwDcqwDaOgDZhVSHiA2M1tWVmbv1iPqiNNxAF78+/cG5RRttJErpG2Pxt3DJJqKkvikW/4kebaZ2JAO4VwG0dQCyC6kOERsYrasrM3frEfVFabiBLnZblmhINBKl9I2x+Pv3ZBNRUt8Ui/8ujzZTO5Ia3KsA2joA2YVUh4gNjNbVlZm79Yj6ojTcQBe7J080JBqJUvrGWPzkDbKJKKlvisW/xUObqR3J3RsByC6kOkRsYLSurszcrUfUF6XhBrrYDZmiIdFIlNI3xuJn7pBNREl9Uyz+/T3aTO1I7l4OAJBdSHWI2MBoXV2ZuVuPqC9Kww10sbtxRUOikSilb4zFT9sim4iS+qZY/C93aDO1I7l7fQqA7EKqQ8QGRuvqyszdekR9URpuoIvdii0aEo1EKX1jLH7OHtlElNQ3xeJ/s0ebqR3J3eM5ALILqQ4RGxitqyszd+sR9UVpuIGukxe3IdFIlNI3xmLHq90aNBEl9U2x2B9q7ohmakdy90T/O3r69n9v7K7BnDdqVgAAAABJRU5ErkJggg=='

type Listener = (...args: unknown[]) => void
function event() {
  const listeners = new Set<Listener>()
  return { addListener: (listener: Listener) => listeners.add(listener), removeListener: (listener: Listener) => listeners.delete(listener) }
}

function memoryStorage(initial: Record<string, unknown>) {
  const data = { ...initial }
  return {
    async get(keys: string | string[] | null) {
      if (keys === null) return structuredClone(data)
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])]))
    },
    async set(values: Record<string, unknown>) { Object.assign(data, structuredClone(values)) },
    async remove(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key] },
  }
}

export function createPreviewPlatform() {
  const tab = { id: 1, windowId: 1, url: sampleJob.url, active: true }
  return {
    storage: { sync: memoryStorage({ settings: sampleSettings }), local: memoryStorage({}), onChanged: event() },
    runtime: {
      onMessage: event(), lastError: undefined,
      getURL: (path?: string) => /^icons\/icon(?:16|32|48|128)\.png$/.test(path ?? '') ? previewIcon : '#preview-only',
      async sendMessage(message: { type?: string }, callback?: (value: unknown) => void) {
        const result = previewMessage(message.type ?? '')
        callback?.(result)
        return result
      },
    },
    tabs: {
      onActivated: event(), onUpdated: event(),
      async query(_query: unknown, callback?: (tabs: typeof tab[]) => void) { callback?.([tab]); return [tab] },
      async get() { return tab },
      async sendMessage(_id: number, message: { type?: string }) { return previewMessage(message.type ?? '') },
      async create() { throw new Error('Component preview: external navigation is disabled.') },
    },
    windows: { WINDOW_ID_CURRENT: 1 },
    sidePanel: { async open() { throw new Error('Component preview: select Side panel above.') } },
    permissions: {
      onAdded: event(), onRemoved: event(),
      async contains() { return false }, async request() { return false }, async remove() { return false },
      async getAll() { return { origins: [], permissions: [] } },
    },
    webNavigation: { async getAllFrames() { return [{ frameId: 0, parentFrameId: -1, url: sampleJob.url }] } },
    scripting: { async executeScript(): Promise<never> { throw new Error('Component preview: real website access requires the installed extension.') } },
  }
}

export function installPreviewPlatform() {
  Object.defineProperty(window, 'chrome', { configurable: true, value: createPreviewPlatform() })
  // Defense in depth: production API imports are replaced by api.ts at build time,
  // and the generated document also enforces CSP connect-src 'none'.
  window.fetch = async () => { throw new Error('Network is disabled in the component preview.') }
}
