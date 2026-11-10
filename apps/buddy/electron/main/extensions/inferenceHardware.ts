import type { InferenceHardware } from '../../../shared/extensions/extensionInference'
import { execFile } from 'node:child_process'
import { cpus, platform, totalmem } from 'node:os'
import { z } from 'zod'

const gpuInfoSchema = z.object({ GPUDevice: z.array(z.object({
  vendorId: z.number().int().optional(),
  vendorString: z.string().max(256).optional(),
  deviceString: z.string().max(256).optional(),
}).strip()).max(16) }).strip()
const vendors: Record<number, InferenceHardware['gpus'][number]['vendor']> = { 0x10DE: 'nvidia', 0x1002: 'amd', 0x8086: 'intel', 0x106B: 'apple' }

function bytes(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function nvidiaMemory(): Promise<string> {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'], { timeout: 2000, maxBuffer: 8192, encoding: 'utf8', windowsHide: true, shell: false }, (error, stdout) => resolve(error ? '' : stdout))
  })
}

async function boundedGpuInfo(getGPUInfo: () => Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(getGPUInfo),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 1500, undefined)
      }),
    ])
  }
  catch { return undefined }
  finally { clearTimeout(timer) }
}

async function readGpus(getGPUInfo: () => Promise<unknown>): Promise<InferenceHardware['gpus']> {
  const [gpuInfo, nvidia] = await Promise.all([boundedGpuInfo(getGPUInfo), ['linux', 'win32'].includes(platform()) ? nvidiaMemory() : Promise.resolve('')])
  const info = gpuInfoSchema.safeParse(gpuInfo)
  const gpus = (info.success ? info.data.GPUDevice : []).filter(device => !/swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render/i.test(`${device.vendorString ?? ''} ${device.deviceString ?? ''}`)).map((device) => {
    const vendorName = device.vendorString?.trim().toLowerCase()
    const vendor = vendors[device.vendorId ?? 0] ?? (vendorName === 'nvidia' || vendorName === 'amd' || vendorName === 'intel' || vendorName === 'apple' ? vendorName : 'unknown')
    return { name: device.deviceString?.trim() || device.vendorString?.trim() || vendor, vendor } satisfies InferenceHardware['gpus'][number]
  })
  if (platform() !== 'linux' && platform() !== 'win32')
    return gpus
  const rows = nvidia.trim().split('\n').slice(0, 16).flatMap((line) => {
    const match = /^([^,\r\n]{1,256}),\s*([^,]{1,40}),\s*([^,]{1,40})$/.exec(line.trim())
    if (!match || !match[1]!.trim())
      return []
    const total = match[2]!.trim()
    const available = match[3]!.trim()
    const totalMemoryBytes = /^\d+$/.test(total) ? bytes(Number(total) * 1024 ** 2) : undefined
    const availableMemoryBytes = /^\d+$/.test(available) ? bytes(Number(available) * 1024 ** 2) : undefined
    return [{
      name: match[1]!.trim(),
      ...(totalMemoryBytes !== undefined ? { totalMemoryBytes } : {}),
      ...(totalMemoryBytes !== undefined && availableMemoryBytes !== undefined && availableMemoryBytes <= totalMemoryBytes ? { availableMemoryBytes } : {}),
    }]
  })
  if (!rows.length)
    return gpus
  return [...gpus.filter(gpu => gpu.vendor !== 'nvidia'), ...rows.map(row => ({ ...row, vendor: 'nvidia' as const }))].slice(0, 16)
}

export function createInferenceHardwareProvider(ports: {
  getGPUInfo: () => Promise<unknown>
  getSystemMemoryInfo: () => { available?: number }
}): (includeGpu: boolean) => Promise<InferenceHardware> {
  const cache = new Map<boolean, { expiresAt: number, value: Promise<InferenceHardware> }>()
  return (includeGpu) => {
    const current = cache.get(includeGpu)
    if (current && current.expiresAt > Date.now())
      return current.value.then(value => structuredClone(value))
    const sampledAt = Date.now()
    const value = (async (): Promise<InferenceHardware> => {
      const totalMemoryBytes = totalmem()
      let availableMemoryBytes: number | undefined
      try {
        const available = ports.getSystemMemoryInfo().available
        availableMemoryBytes = available === undefined ? undefined : bytes(available * 1024)
      }
      catch {}
      return {
        sampledAt,
        logicalCores: cpus().length,
        totalMemoryBytes,
        ...(availableMemoryBytes !== undefined && availableMemoryBytes <= totalMemoryBytes ? { availableMemoryBytes } : {}),
        gpus: includeGpu ? await readGpus(ports.getGPUInfo) : [],
      }
    })()
    cache.set(includeGpu, { expiresAt: sampledAt + 15000, value })
    return value.then(snapshot => structuredClone(snapshot))
  }
}
