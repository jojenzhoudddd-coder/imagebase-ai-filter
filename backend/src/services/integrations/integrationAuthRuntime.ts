import { getAgentIntegration } from "./integrationStore.js";
import { pollLarkAuth, startLarkAuth } from "./larkAuthRuntime.js";

export interface StartIntegrationAuthOptions {
  requireAgentId?: string;
  recommend?: boolean;
  domains?: string[];
  scope?: string;
  providerOptions?: Record<string, unknown>;
}

export interface PollIntegrationAuthOptions {
  requireAgentId?: string;
  integrationId?: string;
}

export async function startIntegrationAuth(
  integrationId: string,
  opts?: StartIntegrationAuthOptions,
): Promise<unknown> {
  const integration = await getAgentIntegration(integrationId, {
    requireAgentId: opts?.requireAgentId,
  });
  if (!integration) throw new Error(`integration not found: ${integrationId}`);
  if (integration.providerKey === "lark" && integration.transport === "cli") {
    return startLarkAuth(integration.id, {
      requireAgentId: opts?.requireAgentId,
      recommend: opts?.recommend,
      domains: opts?.domains,
      scope: opts?.scope,
    });
  }
  return unsupportedAuthAdapter({
    integrationId: integration.id,
    providerKey: integration.providerKey,
    displayName: integration.displayName,
    transport: integration.transport,
  });
}

export async function pollIntegrationAuth(
  authSessionId: string,
  opts?: PollIntegrationAuthOptions,
): Promise<unknown> {
  if (opts?.integrationId) {
    const integration = await getAgentIntegration(opts.integrationId, {
      requireAgentId: opts?.requireAgentId,
    });
    if (!integration) throw new Error(`integration not found: ${opts.integrationId}`);
    if (integration.providerKey === "lark" && integration.transport === "cli") {
      return pollLarkAuth(authSessionId, {
        requireAgentId: opts?.requireAgentId,
        integrationId: integration.id,
      });
    }
    return unsupportedAuthAdapter({
      integrationId: integration.id,
      providerKey: integration.providerKey,
      displayName: integration.displayName,
      transport: integration.transport,
    });
  }

  if (authSessionId.startsWith("las_")) {
    return pollLarkAuth(authSessionId, {
      requireAgentId: opts?.requireAgentId,
    });
  }

  return {
    ok: false,
    status: "unsupported",
    authSessionId,
    error: "auth session id is not recognized; pass integrationId so the generic auth router can choose an adapter",
  };
}

function unsupportedAuthAdapter(input: {
  integrationId: string;
  providerKey: string;
  displayName: string;
  transport: string;
}): Record<string, unknown> {
  return {
    ok: false,
    status: "unsupported",
    integrationId: input.integrationId,
    providerKey: input.providerKey,
    displayName: input.displayName,
    transport: input.transport,
    error: "This integration does not declare an interactive auth adapter yet.",
    nextStep:
      "Add a provider auth adapter that can start a session, surface a verification URL/QR/code, and poll completion.",
  };
}
