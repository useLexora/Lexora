import process from 'node:process'
import { currentPlatform } from '../../../platform/currentPlatform'
import { resolveWindowsPowerShell } from '../../../platform/windows/powerShell'
import { clearAmbientProviderCredentials } from '../providers/providerEnvironment'

export async function prepareRuntimeEnvironment(): Promise<void> {
  clearAmbientProviderCredentials(process.env)
  if (currentPlatform.shell === 'powershell')
    process.env.PI_POWERSHELL_PATH ??= await resolveWindowsPowerShell()
}
