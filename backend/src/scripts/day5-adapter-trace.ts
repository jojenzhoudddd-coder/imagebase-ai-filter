/**
 * Trace adapter output event-by-event for a specific model.
 * Run: npx tsx src/scripts/day5-adapter-trace.ts <modelId>
 */
import "dotenv/config";
import "../services/providers/index.js";
import { getModel, resolveAdapter } from "../services/modelRegistry.js";

async function main() {
  const id = process.argv[2] || "claude-opus-4.7";
  const model = getModel(id);
  if (!model) throw new Error(`unknown model: ${id}`);
  const adapter = resolveAdapter(model);
  console.log(`tracing ${id} via ${adapter.name}\n`);

  const stream = adapter.stream({
    model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: "你是一个简短的助手。回答前请先在 thinking 块里思考一下。",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "请先思考光的散射原理，再用一句话向小学生解释为什么天空是蓝色的",
          },
        ],
      },
    ],
    tools: [],
    signal: new AbortController().signal,
  });

  let i = 0;
  for await (const ev of stream) {
    if (ev.kind === "text_delta") {
      console.log(`[${++i}] text_delta len=${ev.text.length}`);
    } else if (ev.kind === "thinking_delta") {
      console.log(`[${++i}] thinking_delta len=${ev.text.length}${ev.text ? ` text="${ev.text.slice(0, 40)}…"` : " (empty marker)"}`);
    } else {
      console.log(`[${++i}] ${ev.kind}${"error" in ev ? " " + ev.error : ""}`);
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
