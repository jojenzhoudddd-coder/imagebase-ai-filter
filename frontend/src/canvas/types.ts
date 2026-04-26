/**
 * Magic Canvas types —— Block + LayoutNode + per-block 内部 state。
 *
 * 设计:
 *  - canvas 只管 {block id 列表 + 二叉布局树}
 *  - 每个 block 自己的"看哪个 artifact / sidebar 收起 / 哪条会话"作为 internal state
 *    存在 blockStates map 里(随 layout 一并写入后端)
 *  - LayoutNode 是 split 二叉树:每个内部节点是一刀切（h=垂直切左右 / v=水平切上下）,
 *    叶子是 block。任何 block 必占满矩形,永不留白永不重叠。
 */

export type BlockType = "chat" | "artifact" | "system";

export type ArtifactKind = "table" | "idea" | "design" | "demo";

export interface Block {
  id: string;
  type: BlockType;
}

export interface ArtifactBlockState {
  /** 当前 block 看的 artifact;null 表示空白未选 */
  active: { type: ArtifactKind; id: string } | null;
  /** 用户主动设置的 sidebar 折叠态(不被宽度自动收起污染) */
  sidebarCollapsedPreference: boolean;
  /** sidebar 宽度(可拖宽);默认 190 */
  sidebarWidth?: number;
}

export interface ChatBlockState {
  /** 占位:未来支持多会话时存当前会话 id;V1 不用 */
  conversationId?: string;
}

export interface SystemBlockState {
  view?: string;
}

export type BlockState = ArtifactBlockState | ChatBlockState | SystemBlockState | undefined;

export type LayoutNode =
  | { kind: "leaf"; blockId: string }
  | {
      kind: "split";
      /** h: 垂直分隔线(切左右); v: 水平分隔线(切上下) */
      orientation: "h" | "v";
      /** first 占的比例 [0,1];second 占 1-ratio */
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };

export interface CanvasState {
  blocks: Record<string, Block>;
  /** 每个 block 的 internal state(artifact 的 active / sidebar 等) */
  blockStates: Record<string, BlockState>;
  layout: LayoutNode | null;
}

export interface AdjacencyEdges {
  top: "page" | "neighbor";
  right: "page" | "neighbor";
  bottom: "page" | "neighbor";
  left: "page" | "neighbor";
}
