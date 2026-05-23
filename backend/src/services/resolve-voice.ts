/**
 * 配音音色解析
 * 优先使用角色已分配的音色，其次使用音频服务的默认音色
 */
import { getAudioConfigById } from './ai.js'
import type { AIConfig } from './ai.js'

// 各供应商的默认音色
const PROVIDER_DEFAULTS: Record<string, string> = {
  'edge-tts': 'zh-CN-XiaoxiaoNeural',
  'minimax': 'ZhiMei',
  'tencent-tts': 'ZhiMei',
  'ali-tts': 'longxiaochun',
}

/**
 * 解析配音音色
 * @param assignedVoice 角色已分配的音色（可能无效或不存在）
 * @param configId 音频配置 ID，用于获取配置的默认音色
 * @returns 最终的 voiceId
 */
export function resolveVoice(assignedVoice: string | null | undefined, configId?: number | null): string {
  // 1. 如果有已分配的音色且不是 'alloy' 等无效占位符，直接使用
  if (assignedVoice && assignedVoice !== 'alloy' && assignedVoice !== 'echo' && assignedVoice !== 'nova') {
    return assignedVoice
  }

  // 2. 尝试从音频配置的默认音色中获取
  try {
    const config = getAudioConfigById(configId)
    if (config.settings?.default_voice) {
      return config.settings.default_voice
    }
    // 3. 使用供应商内置默认
    if (PROVIDER_DEFAULTS[config.provider]) {
      return PROVIDER_DEFAULTS[config.provider]
    }
  } catch {
    // 配置不存在时忽略
  }

  // 4. 兜底
  return 'zh-CN-XiaoxiaoNeural'
}
