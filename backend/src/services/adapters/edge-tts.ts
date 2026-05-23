/**
 * Edge TTS 语音合成 Adapter
 * 基于 edge-tts-universal (WebSocket → 微软 Bing TTS)
 * 不走 HTTP 请求，直接通过 adapter.synthesize() 合成
 */
import type { TTSProviderAdapter } from './types'
import type { AIConfig } from './types'

export class EdgeTTSTTSAdapter implements TTSProviderAdapter {
  readonly provider = 'edge-tts'

  buildGenerateRequest(): any {
    // edge-tts 不走 HTTP，此方法不应被调用
    throw new Error('Edge-TTS does not support HTTP-based generation')
  }

  parseResponse(): any {
    throw new Error('Edge-TTS does not support HTTP-based response parsing')
  }

  async synthesize(config: AIConfig, params: any): Promise<{
    audioHex: string
    audioLength: number
    sampleRate: number
    bitrate: number
    format: string
    channel: number
  }> {
    const { Communicate } = await import('edge-tts-universal')
    const text = params.text
    const voice = params.voice || config.settings?.default_voice || 'zh-CN-XiaoxiaoNeural'

    const communicate = new Communicate(text, { voice, connectionTimeout: 15000 })
    const audioChunks: Uint8Array[] = []

    for await (const chunk of communicate.stream()) {
      if (chunk.type === 'audio' && chunk.data) {
        audioChunks.push(chunk.data)
      }
    }

    if (audioChunks.length === 0) {
      throw new Error('未接收到音频数据，请检查服务器网络是否能访问 bing.com')
    }

    const totalLength = audioChunks.reduce((s, c) => s + c.length, 0)
    const merged = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of audioChunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }

    // Edge TTS 输出为 24kHz 48kbps 单声道 mp3
    const audioMs = Math.round((totalLength / 6000) * 1000) // ~6KB/s for 48kbps

    return {
      audioHex: Buffer.from(merged).toString('hex'),
      audioLength: audioMs,
      sampleRate: 24000,
      bitrate: 48000,
      format: 'mp3',
      channel: 1,
    }
  }
}
