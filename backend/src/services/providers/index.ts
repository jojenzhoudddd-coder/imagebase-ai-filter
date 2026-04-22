/**
 * Provider registry bootstrap — importing this module registers every
 * available adapter with the model registry. Importing it once from
 * chatAgentService is sufficient.
 *
 * Day 1 shipped arkAdapter. Day 2 adds oneapiAdapter (Claude via Anthropic
 * native `/v1/messages`, GPT-5 via OpenAI-compatible `/v1/chat/completions`).
 */

import { registerProviderAdapter } from "../modelRegistry.js";
import { arkAdapter } from "./arkAdapter.js";
import { oneapiAdapter } from "./oneapiAdapter.js";

registerProviderAdapter(arkAdapter);
registerProviderAdapter(oneapiAdapter);

export { arkAdapter, oneapiAdapter };
