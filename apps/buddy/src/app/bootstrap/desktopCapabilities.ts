import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { Ref } from 'vue'
import type { DesktopStores } from '@/app/bootstrap/useDesktopAppState'
import type { AutomationCapability } from '@/modules/automations'
import type { DesktopDataSettingsCapability, McpSettingsCapability, WebSettingsCapability } from '@/modules/settings'
import { useAutomationCapability } from '@/modules/automations'
import { createDesktopDataSettingsCapability, useMcpSettingsCapability, useWebSettingsCapability } from '@/modules/settings'

export interface DesktopCapabilities {
  automations: AutomationCapability
  dataSettings: DesktopDataSettingsCapability
  webSettings: WebSettingsCapability
  mcpSettings: McpSettingsCapability
}

interface CreateDesktopCapabilitiesInput {
  api: LexoraDesktopApi
  stores: DesktopStores
  selectedModel: Readonly<Ref<LocalRuntimeModelOption | null>>
  onAutomationRunFailure: (message: string) => void
}

export function createDesktopCapabilities(
  input: CreateDesktopCapabilitiesInput,
): DesktopCapabilities {
  const { stores } = input
  return {
    automations: useAutomationCapability({
      api: input.api.localChat,
      language: stores.applicationSettings.language,
      onRunFailure: input.onAutomationRunFailure,
    }),
    dataSettings: createDesktopDataSettingsCapability({
      api: input.api.localChat,
      applicationSettings: stores.applicationSettings,
      selectedModel: input.selectedModel,
      runtimeSupervisor: stores.runtimeSupervisor,
      usage: stores.usage,
    }),
    mcpSettings: useMcpSettingsCapability({ api: input.api.localChat.connectors, language: stores.applicationSettings.language }),
    webSettings: useWebSettingsCapability({ api: input.api.localChat.web, language: stores.applicationSettings.language }),
  }
}
