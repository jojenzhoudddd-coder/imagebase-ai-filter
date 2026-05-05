/**
 * Tier 0 model management tools — Agent can add/list/remove/test custom models.
 *
 * These tools let the Agent configure models on behalf of the user through
 * natural conversation (the "Add by chat" flow in the Models tab).
 */

import type { ToolDefinition } from "./tableTools.js";

const BASE_URL = `http://localhost:${process.env.PORT || 3001}`;

export const modelTools: ToolDefinition[] = [
  {
    name: "add_model",
    description:
      "Add a custom AI model to the user's model list. The model will be available for selection in the chat model picker. Requires: modelId (unique ID), displayName, provider type, baseUrl, apiKey, providerModelId, and optionally capabilities.",
    inputSchema: {
      type: "object",
      properties: {
        modelId: { type: "string", description: "Unique model identifier (e.g. 'my-gpt4')" },
        displayName: { type: "string", description: "Human-readable name (e.g. 'My GPT-4')" },
        provider: { type: "string", enum: ["openai-compatible", "anthropic", "custom"], description: "Provider type" },
        baseUrl: { type: "string", description: "API endpoint base URL" },
        apiKey: { type: "string", description: "API key for authentication" },
        providerModelId: { type: "string", description: "Model ID as expected by the provider API" },
        capabilities: {
          type: "object",
          properties: {
            thinking: { type: "boolean" },
            toolUse: { type: "boolean" },
            contextWindow: { type: "number" },
          },
          description: "Model capabilities (optional)",
        },
        specialty: { type: "string", description: "Model specialty (e.g. 'code', 'reasoning', 'general')" },
      },
      required: ["modelId", "displayName", "provider", "baseUrl", "apiKey", "providerModelId"],
    },
    handler: async (args: Record<string, unknown>, ctx?: any) => {
      const res = await fetch(`${BASE_URL}/api/models/custom`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `auth_token=${ctx?.authToken ?? ""}` },
        body: JSON.stringify(args),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return JSON.stringify({ ok: false, error: (err as any).error ?? `HTTP ${res.status}` });
      }
      const model = await res.json();
      return JSON.stringify({ ok: true, model });
    },
  },
  {
    name: "list_custom_models",
    description: "List all custom models configured by the current user.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args: Record<string, unknown>, ctx?: any) => {
      const res = await fetch(`${BASE_URL}/api/models/custom`, {
        headers: { Cookie: `auth_token=${ctx?.authToken ?? ""}` },
      });
      if (!res.ok) {
        return JSON.stringify({ ok: false, error: `HTTP ${res.status}` });
      }
      const data = await res.json();
      return JSON.stringify({ ok: true, models: data.models ?? [] });
    },
  },
  {
    name: "remove_model",
    description: "Remove a custom model from the user's model list by its database ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The database ID of the custom model to remove" },
      },
      required: ["id"],
    },
    handler: async (args: Record<string, unknown>, ctx?: any) => {
      const res = await fetch(`${BASE_URL}/api/models/custom/${args.id}`, {
        method: "DELETE",
        headers: { Cookie: `auth_token=${ctx?.authToken ?? ""}` },
      });
      if (res.status === 204) return JSON.stringify({ ok: true });
      const err = await res.json().catch(() => ({}));
      return JSON.stringify({ ok: false, error: (err as any).error ?? `HTTP ${res.status}` });
    },
  },
  {
    name: "test_model",
    description: "Test connectivity of a model by sending a simple prompt. Use this to verify that the baseUrl and apiKey work before saving.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["openai-compatible", "anthropic", "custom"] },
        baseUrl: { type: "string", description: "API endpoint base URL" },
        apiKey: { type: "string", description: "API key" },
        providerModelId: { type: "string", description: "Model ID to test" },
      },
      required: ["provider", "baseUrl", "apiKey", "providerModelId"],
    },
    handler: async (args: Record<string, unknown>) => {
      const { provider, baseUrl, apiKey, providerModelId } = args as {
        provider: string; baseUrl: string; apiKey: string; providerModelId: string;
      };
      try {
        let testRes: Response;
        if (provider === "anthropic") {
          testRes = await fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: providerModelId,
              max_tokens: 10,
              messages: [{ role: "user", content: "Hi" }],
            }),
          });
        } else {
          // OpenAI-compatible
          testRes = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: providerModelId,
              max_tokens: 10,
              messages: [{ role: "user", content: "Hi" }],
            }),
          });
        }
        if (testRes.ok) {
          return JSON.stringify({ ok: true, message: "Model responded successfully" });
        }
        const body = await testRes.text().catch(() => "");
        return JSON.stringify({ ok: false, status: testRes.status, message: body.slice(0, 200) });
      } catch (err: any) {
        return JSON.stringify({ ok: false, error: err.message ?? "Connection failed" });
      }
    },
  },
];
