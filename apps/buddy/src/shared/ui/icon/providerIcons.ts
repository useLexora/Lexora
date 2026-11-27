// Monochrome Lobe Icons, pinned to @lobehub/icons-static-svg 1.98.0.
// See public/third-party/lobe-icons-LICENSE.txt for provenance and license.
import anthropic from './assets/providers/anthropic.svg'
import azure from './assets/providers/azure.svg'
import baseten from './assets/providers/baseten.svg'
import bedrock from './assets/providers/bedrock.svg'
import cerebras from './assets/providers/cerebras.svg'
import cloudflare from './assets/providers/cloudflare.svg'
import deepseek from './assets/providers/deepseek.svg'
import fireworks from './assets/providers/fireworks.svg'
import githubcopilot from './assets/providers/githubcopilot.svg'
import google from './assets/providers/google.svg'
import groq from './assets/providers/groq.svg'
import huggingface from './assets/providers/huggingface.svg'
import kimi from './assets/providers/kimi.svg'
import ling from './assets/providers/ling.svg'
import meta from './assets/providers/meta.svg'
import minimax from './assets/providers/minimax.svg'
import mistral from './assets/providers/mistral.svg'
import moonshot from './assets/providers/moonshot.svg'
import nvidia from './assets/providers/nvidia.svg'
import openai from './assets/providers/openai.svg'
import opencode from './assets/providers/opencode.svg'
import openrouter from './assets/providers/openrouter.svg'
import qwen from './assets/providers/qwen.svg'
import together from './assets/providers/together.svg'
import typesafeai from './assets/providers/typesafeai.svg'
import vercel from './assets/providers/vercel.svg'
import vertexai from './assets/providers/vertexai.svg'
import xai from './assets/providers/xai.svg'
import xiaomimimo from './assets/providers/xiaomimimo.svg'
import zai from './assets/providers/zai.svg'

const providerIconUrls = {
  'amazon-bedrock': bedrock,
  'ant-ling': ling,
  'anthropic': anthropic,
  'azure': azure,
  'baseten': baseten,
  'cerebras': cerebras,
  'cloudflare-ai-gateway': cloudflare,
  'cloudflare-workers-ai': cloudflare,
  'deepseek': deepseek,
  'fireworks': fireworks,
  'github-copilot': githubcopilot,
  'google': google,
  'google-vertex': vertexai,
  'groq': groq,
  'huggingface': huggingface,
  'kimi-coding': kimi,
  'meta': meta,
  'minimax': minimax,
  'minimax-cn': minimax,
  'mistral': mistral,
  'moonshotai': moonshot,
  'moonshotai-cn': moonshot,
  'nvidia': nvidia,
  'openai': openai,
  'openai-codex': openai,
  'opencode': opencode,
  'opencode-go': opencode,
  'openrouter': openrouter,
  'qwen-token-plan': qwen,
  'qwen-token-plan-cn': qwen,
  'qwen-token-plan-individual': qwen,
  'qwen-token-plan-individual-cn': qwen,
  'together': together,
  'typesafe': typesafeai,
  'vercel-ai-gateway': vercel,
  'xai': xai,
  'xiaomi': xiaomimimo,
  'xiaomi-token-plan-ams': xiaomimimo,
  'xiaomi-token-plan-cn': xiaomimimo,
  'xiaomi-token-plan-sgp': xiaomimimo,
  'zai': zai,
  'zai-coding-cn': zai,
} as const

export function resolveProviderIcon(providerId: string): string | null {
  return Object.hasOwn(providerIconUrls, providerId)
    ? providerIconUrls[providerId as keyof typeof providerIconUrls]
    : null
}
