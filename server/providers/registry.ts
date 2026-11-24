// Multi-provider registry managing cloud AI generation providers and per-app availability.
import type { App } from "../registry.ts";
import { bindingForApp } from "./app-mapping.ts";
import { FalProvider } from "./fal.ts";
import type { AppProviderBinding, GenerationProvider, ProviderStatus } from "./types.ts";

export class ProviderRegistry {
  private providers = new Map<string, GenerationProvider>();

  constructor(initial: GenerationProvider[] = [new FalProvider()]) {
    for (const p of initial) this.providers.set(p.id, p);
  }

  get(id: string): GenerationProvider | undefined {
    return this.providers.get(id);
  }

  listStatuses(): ProviderStatus[] {
    return [...this.providers.values()].map((p) => p.status());
  }

  appBinding(app: App): AppProviderBinding & { available: boolean; providerName: string | null } {
    const binding = bindingForApp(app);
    if (!binding.supported || !binding.provider) {
      return { ...binding, available: false, providerName: null };
    }
    const provider = this.providers.get(binding.provider);
    if (!provider) {
      return {
        ...binding,
        supported: false,
        available: false,
        providerName: null,
        unavailableReason: `Provider "${binding.provider}" is not registered.`,
      };
    }
    const st = provider.status();
    return {
      ...binding,
      available: st.configured && st.available,
      providerName: provider.name,
      unavailableReason: st.available ? null : st.reason,
    };
  }

  overview(apps: readonly App[]) {
    const statuses = this.listStatuses();
    let supportedCount = 0;
    let readyCount = 0;
    let unsupportedCount = 0;
    for (const a of apps) {
      const b = this.appBinding(a);
      if (!b.supported) unsupportedCount++;
      else {
        supportedCount++;
        if (b.available) readyCount++;
      }
    }
    return {
      providers: statuses,
      any_available: statuses.some((p) => p.available),
      summary: {
        total_apps: apps.length,
        supported_apps: supportedCount,
        ready_apps: readyCount,
        unsupported_apps: unsupportedCount,
      },
    };
  }
}
