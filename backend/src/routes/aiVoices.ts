/**
 * AI 音色管理
 * GET  /api/v1/ai-voices                - 获取音色列表
 * POST /api/v1/ai-voices/sync           - 同步所有活跃音频供应商的音色
 * POST /api/v1/ai-voices/sync?provider= - 同步指定供应商
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { createHmac, createHash } from 'node:crypto'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { joinProviderUrl } from '../services/adapters/url.js'

/* ── 内置音色数据 ────────────────────────────────── */

const EDGE_TTS_VOICES = [
  // 中文普通话
  { voiceId: 'zh-CN-XiaoxiaoNeural', voiceName: '晓晓（女）', language: '中文' },
  { voiceId: 'zh-CN-XiaoyiNeural', voiceName: '晓伊（女）', language: '中文' },
  { voiceId: 'zh-CN-YunjianNeural', voiceName: '云健（男）', language: '中文' },
  { voiceId: 'zh-CN-YunxiNeural', voiceName: '云希（男）', language: '中文' },
  { voiceId: 'zh-CN-YunxiaNeural', voiceName: '云夏（男）', language: '中文' },
  { voiceId: 'zh-CN-YunyangNeural', voiceName: '云扬（男）', language: '中文' },
  // 粤语
  { voiceId: 'zh-HK-HiuGaaiNeural', voiceName: '晓佳（女粤）', language: '粤语' },
  { voiceId: 'zh-HK-HiuMaanNeural', voiceName: '晓曼（女粤）', language: '粤语' },
  { voiceId: 'zh-HK-WanLungNeural', voiceName: '云龙（男粤）', language: '粤语' },
  // 台湾国语
  { voiceId: 'zh-TW-HsiaoChenNeural', voiceName: '晓臻（女台）', language: '中文' },
  { voiceId: 'zh-TW-HsiaoYuNeural', voiceName: '晓雨（女台）', language: '中文' },
  { voiceId: 'zh-TW-YunJheNeural', voiceName: '云哲（男台）', language: '中文' },
]

const TENCENT_TTS_VOICES = [
  { voiceId: 'ZhiMei', voiceName: '智美（女）', language: '中文' },
  { voiceId: 'ZhiQi', voiceName: '智琪（女）', language: '中文' },
  { voiceId: 'ZhiYun', voiceName: '智芸（女）', language: '中文' },
  { voiceId: 'ZhiDan', voiceName: '智丹（女）', language: '中文' },
  { voiceId: 'ZhiJie', voiceName: '智杰（男）', language: '中文' },
  { voiceId: 'ZhiHua', voiceName: '智华（男）', language: '中文' },
  { voiceId: 'ZhiHao', voiceName: '智浩（男）', language: '中文' },
]

const ALI_TTS_VOICES = [
  { voiceId: 'longxiaochun', voiceName: '龙小春（女）', language: '中文' },
  { voiceId: 'longxiaomeng', voiceName: '龙小梦（女）', language: '中文' },
  { voiceId: 'longxiaohui', voiceName: '龙小慧（女）', language: '中文' },
  { voiceId: 'longxiaoxia', voiceName: '龙小夏（女）', language: '中文' },
  { voiceId: 'longxiaohan', voiceName: '龙小寒（女）', language: '中文' },
  { voiceId: 'longxiaokang', voiceName: '龙小康（男）', language: '中文' },
  { voiceId: 'longxiaosheng', voiceName: '龙小生（男）', language: '中文' },
  { voiceId: 'longxiaochen', voiceName: '龙小晨（男）', language: '中文' },
  { voiceId: 'longxiaowen', voiceName: '龙小文（男）', language: '中文' },
]

interface SyncResult {
  count: number
  message: string
}

const app = new Hono()

// GET /ai-voices?provider=minimax
app.get('/', async (c) => {
  const provider = c.req.query('provider') || 'minimax'
  const rows = db.select().from(schema.aiVoices)
    .where(eq(schema.aiVoices.provider, provider))
    .all()

  const parsed = rows.map(r => ({
    voice_id: r.voiceId,
    voice_name: r.voiceName,
    description: r.description ? JSON.parse(r.description) : [],
    language: r.language,
    provider: r.provider,
  }))

  return success(c, parsed)
})

// POST /ai-voices/sync?provider=all|minimax|edge-tts|tencent-tts|ali-tts
app.post('/sync', async (c) => {
  const provider = c.req.query('provider') || 'all'

  const audioConfigs = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'audio'))
    .all()
    .filter(r => r.isActive)

  const tasks: { provider: string; fn: () => Promise<SyncResult> }[] = []

  if (provider === 'all' || provider === 'minimax') {
    const cfg = audioConfigs.find(r => r.provider === 'minimax')
    tasks.push({ provider: 'minimax', fn: () => cfg ? syncMiniMax(cfg) : Promise.resolve({ count: 0, message: '未找到活跃的 MiniMax 配置' }) })
  }
  if (provider === 'all' || provider === 'edge-tts') {
    tasks.push({ provider: 'edge-tts', fn: () => syncHardcoded('edge-tts', EDGE_TTS_VOICES) })
  }
  if (provider === 'all' || provider === 'tencent-tts') {
    const cfg = audioConfigs.find(r => r.provider === 'tencent-tts')
    tasks.push({ provider: 'tencent-tts', fn: () => cfg ? syncTencentTts(cfg) : syncHardcoded('tencent-tts', TENCENT_TTS_VOICES) })
  }
  if (provider === 'all' || provider === 'ali-tts') {
    tasks.push({ provider: 'ali-tts', fn: () => syncHardcoded('ali-tts', ALI_TTS_VOICES) })
  }

  const results = await Promise.all(tasks.map(t => t.fn().then(r => ({ provider: t.provider, ...r }))))
  const total = results.reduce((s, r) => s + r.count, 0)

  return success(c, { results, total, message: `同步完成，共 ${total} 个音色` })
})

/* ── 同步函数 ────────────────────────────────────── */

// POST /ai-voices/edge-tts/synthesize
app.post('/edge-tts/synthesize', async (c) => {
  const body = await c.req.json()
  const { text, voice } = body
  if (!text || !voice) return badRequest(c, 'text and voice are required')

  try {
    const { Communicate } = await import('edge-tts-universal')
    const communicate = new Communicate(text, {
      voice,
      connectionTimeout: 10000,
    })

    const audioChunks: Uint8Array[] = []
    for await (const chunk of communicate.stream()) {
      if (chunk.type === 'audio' && chunk.data) {
        audioChunks.push(chunk.data)
      }
    }

    if (audioChunks.length === 0) {
      // Retry once
      const retry = new Communicate(text, { voice, connectionTimeout: 10000 })
      for await (const chunk of retry.stream()) {
        if (chunk.type === 'audio' && chunk.data) {
          audioChunks.push(chunk.data)
        }
      }
    }

    if (audioChunks.length === 0) {
      return badRequest(c, '未接收到音频数据，请检查服务器网络是否能访问 bing.com')
    }

    const totalLength = audioChunks.reduce((s, c) => s + c.length, 0)
    const merged = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of audioChunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }

    return new Response(new Blob([merged], { type: 'audio/mpeg' }), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    })
  } catch (error: any) {
    console.error('[EdgeTTS] 合成失败:', error)
    return badRequest(c, `Edge TTS 合成失败: ${error.message || error}`)
  }
})

// POST /ai-voices/edge-tts/test-ws
app.post('/edge-tts/test-ws', async (c) => {
  try {
    const WebSocket = globalThis.WebSocket || (await import('isomorphic-ws')).default
    const start = Date.now()
    const result = await new Promise<{ ok: boolean; ms: number; error?: string }>((resolve) => {
      const ws = new WebSocket('wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClient=Edge')
      const timeout = setTimeout(() => {
        ws.close()
        resolve({ ok: false, ms: Date.now() - start, error: '连接超时 (15s)' })
      }, 15000)
      ws.addEventListener('open', () => {
        clearTimeout(timeout)
        resolve({ ok: true, ms: Date.now() - start })
        ws.close()
      })
      ws.addEventListener('error', (err: any) => {
        clearTimeout(timeout)
        resolve({ ok: false, ms: Date.now() - start, error: err.message || '未知错误' })
      })
    })
    return success(c, result)
  } catch (error: any) {
    return success(c, { ok: false, ms: 0, error: error.message })
  }
})

async function syncMiniMax(config: any): Promise<SyncResult> {
  if (!config.apiKey) return { count: 0, message: 'MiniMax API key 未配置' }

  const resp = await fetch(joinProviderUrl(config.baseUrl, '/v1', '/get_voice'), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ voice_type: 'all' }),
  })

  if (!resp.ok) return { count: 0, message: `MiniMax API 错误: ${resp.status}` }

  const result = await resp.json() as any
  if (result.base_resp?.status_code !== 0) {
    return { count: 0, message: result.base_resp?.status_msg || '获取音色失败' }
  }

  const voices = (result.system_voice || []).filter((v: any) => shouldKeepVoice(v))
  const ts = now()

  db.delete(schema.aiVoices).where(eq(schema.aiVoices.provider, 'minimax')).run()

  const insertRows = voices.map((v: any) => ({
    voiceId: v.voice_id,
    voiceName: v.voice_name,
    description: JSON.stringify(v.description || []),
    language: extractLanguage(v.voice_id, v.voice_name),
    provider: 'minimax',
    createdAt: ts,
  }))

  if (insertRows.length > 0) db.insert(schema.aiVoices).values(insertRows).run()

  return { count: insertRows.length, message: `同步了 ${insertRows.length} 个 MiniMax 音色` }
}

async function syncHardcoded(provider: string, voiceList: typeof EDGE_TTS_VOICES): Promise<SyncResult> {
  const ts = now()

  db.delete(schema.aiVoices).where(eq(schema.aiVoices.provider, provider)).run()

  const rows = voiceList.map(v => ({
    voiceId: v.voiceId,
    voiceName: v.voiceName,
    description: JSON.stringify([{ name: v.voiceName, properties: [] }]),
    language: v.language,
    provider,
    createdAt: ts,
  }))

  db.insert(schema.aiVoices).values(rows).run()

  return { count: rows.length, message: `同步了 ${rows.length} 个 ${provider} 音色` }
}

async function syncTencentTts(config: any): Promise<SyncResult> {
  const secretId = config.apiKey?.trim()
  if (!secretId) return { count: 0, message: 'SecretId 未配置' }

  let settings: any = {}
  try { settings = config.settings ? JSON.parse(config.settings) : {} } catch {}
  const secretKey = settings.secret_key?.trim()
  if (!secretKey) return { count: 0, message: 'SecretKey 未配置（请在设置中填写）' }

  // 优先通过 API 获取音色列表
  try {
    const signed = tencentSign(secretId, secretKey)
    const resp = await fetch(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
    })

    if (resp.ok) {
      const result = await resp.json() as any
      const voiceSet = result.Response?.VoiceSet || []
      const ts = now()

      db.delete(schema.aiVoices).where(eq(schema.aiVoices.provider, 'tencent-tts')).run()

      const insertRows = voiceSet.map((v: any) => ({
        voiceId: v.VoiceName,
        voiceName: `${v.VoiceName}（${v.Gender === 1 ? '女' : '男'}）`,
        description: JSON.stringify([{ name: v.VoiceName, properties: [] }]),
        language: v.Language === 'Chinese' ? '中文' : '其他',
        provider: 'tencent-tts',
        createdAt: ts,
      }))

      if (insertRows.length > 0) db.insert(schema.aiVoices).values(insertRows).run()
      return { count: insertRows.length, message: `从腾讯云 API 同步了 ${insertRows.length} 个音色` }
    }
  } catch {
    // API 失败，回退内置列表
  }

  // 回退：内置列表
  return syncHardcoded('tencent-tts', TENCENT_TTS_VOICES)
}

/* ── 腾讯云 TC3-HMAC-SHA256 签名 ───────────────── */

function tencentSign(secretId: string, secretKey: string) {
  const service = 'tts'
  const action = 'DescribeTTSVoiceList'
  const version = '2019-08-23'
  const host = `${service}.tencentcloudapi.com`
  const algorithm = 'TC3-HMAC-SHA256'
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10).replace(/-/g, '')

  const payload = '{}'
  const hashedPayload = createHash('sha256').update(payload).digest('hex').toLowerCase()

  const canonicalHeaders = `content-type:application/json\nhost:${host}\n`
  const signedHeaders = 'content-type;host'
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}${signedHeaders}\n${hashedPayload}`

  const credentialScope = `${date}/${service}/tc3_request`
  const hashedCanonicalRequest = createHash('sha256').update(canonicalRequest).digest('hex').toLowerCase()
  const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`

  const tc3Key = createHmac('sha256', `TC3${secretKey}`).update(date).digest()
  const secretDate = createHmac('sha256', tc3Key).update(service).digest()
  const secretService = createHmac('sha256', secretDate).update('tc3_request').digest()
  const signature = createHmac('sha256', secretService).update(stringToSign).digest('hex').toLowerCase()

  const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    url: `https://${host}`,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Timestamp': String(timestamp),
    },
    body: payload,
  }
}

/* ── 工具函数 ────────────────────────────────────── */

function extractLanguage(voiceId: string, voiceName: string): string {
  const text = `${voiceId} ${voiceName}`.toLowerCase()
  if (text.includes('cantonese') || text.includes('粤')) return '粤语'
  if (text.includes('english') || text.includes('aussie')) return '英语'
  if (text.includes('japanese') || text.includes('日语')) return '日语'
  if (text.includes('korean') || text.includes('韩')) return '韩语'
  if (text.includes('spanish')) return '西班牙语'
  if (text.includes('portuguese')) return '葡萄牙语'
  if (text.includes('french')) return '法语'
  if (text.includes('indonesian')) return '印尼语'
  if (text.includes('german')) return '德语'
  if (text.includes('russian')) return '俄语'
  if (text.includes('italian')) return '意大利语'
  if (text.includes('arabic')) return '阿拉伯语'
  if (text.includes('turkish')) return '土耳其语'
  if (text.includes('ukrainian')) return '乌克兰语'
  if (text.includes('dutch')) return '荷兰语'
  if (text.includes('vietnamese')) return '越南语'
  if (text.includes('chinese') || text.includes('mandarin') || text.includes('中文')) return '中文'
  return '其他'
}

function shouldKeepVoice(voice: { voice_id: string; voice_name: string }) {
  const language = extractLanguage(voice.voice_id, voice.voice_name)
  if (language !== '中文' && language !== '粤语') return false
  const text = `${voice.voice_id} ${voice.voice_name}`.toLowerCase()
  const excluded = ['jingpin', '-beta', 'cartoon_pig', 'cute_boy', 'lovely_girl', 'clever_boy', 'robot_armor', 'news_anchor', 'male_announcer', 'radio_host', 'hk_flight_attendant']
  return !excluded.some(p => text.includes(p))
}

export default app
