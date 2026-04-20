// Figma URL parsing utilities — shared by designRoutes and tasteRoutes.

export interface FigmaParsed {
  fileKey: string;
  nodeId: string | null;
}

export function parseFigmaUrl(url: string): FigmaParsed | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("figma.com")) return null;
    const seg = u.pathname.split("/").filter(Boolean);
    if (seg[0] !== "design" && seg[0] !== "file") return null;
    let fileKey: string;
    if (seg[2] === "branch") {
      fileKey = seg[3];
    } else {
      fileKey = seg[1];
    }
    if (!fileKey) return null;
    return { fileKey, nodeId: u.searchParams.get("node-id") };
  } catch {
    return null;
  }
}

export function extractNameFromUrl(url: string): string {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean);
    const raw = seg[seg.length - 1] || "";
    const decoded = decodeURIComponent(raw).replace(/-/g, " ").replace(/\?.*/, "");
    return decoded || "Untitled Design";
  } catch {
    return "Untitled Design";
  }
}
