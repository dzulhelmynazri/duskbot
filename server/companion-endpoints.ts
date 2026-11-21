import { randomUUID } from "node:crypto";
import type { CompanionEndpoint } from "../shared/pairing-link.ts";

/** asked of the desktop main process: `endpoints` is null unless the Mac companion already runs and remote access is allowed */
export type CompanionEndpointsRequest = { type: "madanibot:companion-endpoints"; requestId: string };
export type CompanionEndpointsResult = { type: "madanibot:companion-endpoints-result"; requestId: string; endpoints: CompanionEndpoint[] | null };

const KINDS = new Set<string>(["hosted", "tailnet", "lan", "bonjour"] satisfies CompanionEndpoint["kind"][]);

function cleanEndpoints(value: unknown): CompanionEndpoint[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.slice(0, 16).filter((one): one is CompanionEndpoint => Boolean(one) && typeof one === "object"
    && typeof (one as CompanionEndpoint).url === "string" && (one as CompanionEndpoint).url.length <= 512
    && KINDS.has((one as CompanionEndpoint).kind) && Number.isFinite((one as CompanionEndpoint).priority));
  return out.length ? out : null;
}

export function createCompanionEndpointsBridge(send: (message: CompanionEndpointsRequest) => boolean, timeoutMs = 5_000) {
  const pending = new Map<string, (endpoints: CompanionEndpoint[] | null) => void>();
  return {
    request(): Promise<CompanionEndpoint[] | null> {
      return new Promise((resolve) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => { pending.delete(requestId); resolve(null); }, timeoutMs);
        timer.unref?.();
        pending.set(requestId, (endpoints) => { clearTimeout(timer); pending.delete(requestId); resolve(endpoints); });
        if (!send({ type: "madanibot:companion-endpoints", requestId })) pending.get(requestId)!(null);
      });
    },
    receive(raw: unknown): boolean {
      if (!raw || typeof raw !== "object" || (raw as { type?: unknown }).type !== "madanibot:companion-endpoints-result") return false;
      const message = raw as Partial<CompanionEndpointsResult>;
      if (typeof message.requestId === "string") pending.get(message.requestId)?.(cleanEndpoints(message.endpoints));
      return true;
    },
  };
}
