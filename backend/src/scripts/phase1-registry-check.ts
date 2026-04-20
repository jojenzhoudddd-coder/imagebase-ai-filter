import { allTools, toolsByName, toArkToolFormat } from "../../mcp-server/src/tools/index.js";

console.log("total tools:", allTools.length);
console.log("first 5 names (expect meta-tools first):", allTools.slice(0, 5).map((t) => t.name));
console.log(
  "meta in toolsByName:",
  ["update_profile", "update_soul", "create_memory"].map((n) => [n, Boolean(toolsByName[n])])
);
console.log(
  "ARK format (first 3):",
  JSON.stringify(
    toArkToolFormat()
      .slice(0, 3)
      .map((t) => ({ name: t.name, desc: t.description.slice(0, 40) })),
    null,
    2
  )
);
