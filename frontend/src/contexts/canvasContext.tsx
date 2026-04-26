/**
 * CanvasContext —— Magic Canvas 的核心状态:blocks + layout + per-block state。
 *
 * 持久化:
 *   - hydrate from user.preferences.canvasLayout(/me 时下发)
 *   - mutate 后 debounce 800ms PATCH /api/auth/preferences
 *   - 拖拽中实时更新 React state(本地),拖拽 release 才落盘
 *
 * 默认布局:1 chat(左) + 1 artifact(右), 50/50 split。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Block, BlockState, CanvasState, LayoutNode, BlockType, ArtifactBlockState } from "../canvas/types";
import {
  collectLeaves,
  countLeaves,
  insertNewBlock,
  moveBlockToTarget,
  removeLeaf,
  swapLeaves,
  updateRatioByPath,
} from "../canvas/layoutAlgorithms";
import type { DropSide } from "../canvas/layoutAlgorithms";

const MAX_BLOCKS = 16;
const DEFAULT_SIDEBAR_WIDTH = 190;

function defaultArtifactState(): ArtifactBlockState {
  return { active: null, sidebarCollapsedPreference: false, sidebarWidth: DEFAULT_SIDEBAR_WIDTH };
}

function defaultLayout(): CanvasState {
  const chatId = `blk_${cryptoId()}`;
  const artId = `blk_${cryptoId()}`;
  return {
    blocks: {
      [chatId]: { id: chatId, type: "chat" },
      [artId]: { id: artId, type: "artifact" },
    },
    blockStates: {
      [chatId]: {},
      [artId]: defaultArtifactState(),
    },
    layout: {
      kind: "split",
      orientation: "h",
      ratio: 0.5,
      first: { kind: "leaf", blockId: chatId },
      second: { kind: "leaf", blockId: artId },
    },
  };
}

function cryptoId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID().slice(0, 12);
  return Math.random().toString(36).slice(2, 14);
}

// ─── Persistence ────────────────────────────────────────────────────────

function readLocalCache(): CanvasState | null {
  try {
    const raw = localStorage.getItem("canvas_layout_v1");
    if (!raw) return null;
    return JSON.parse(raw) as CanvasState;
  } catch {
    return null;
  }
}

function writeLocalCache(state: CanvasState): void {
  try {
    localStorage.setItem("canvas_layout_v1", JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

async function persistToBackend(state: CanvasState): Promise<void> {
  try {
    await fetch("/api/auth/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ canvasLayout: state }),
    });
  } catch {
    /* fallback: localStorage only */
  }
}

// ─── Context ───────────────────────────────────────────────────────────

export interface DropTarget {
  blockId: string;
  side: DropSide;
}

export interface CanvasContextValue {
  state: CanvasState;
  /** state 的最新 ref —— 给 pointermove 等 closure 用,避免读到 stale state */
  stateRef: React.MutableRefObject<CanvasState>;
  /** 当前可见的 block id 列表(layout 树上的所有叶子) */
  visibleBlockIds: string[];
  /** 当前是否有 block 正在拖动 —— canvas 根据这个加 .mc-canvas--dragging class */
  dragging: boolean;
  setDragging: (v: boolean) => void;
  /** 当前拖动的源 block id,落位时用 */
  dragSourceId: string | null;
  setDragSourceId: (id: string | null) => void;
  /** 当前拖动悬停的落位目标(block + 边),用于实时高亮 drop indicator。
   *  拖动期间一直有,松手时才执行落位。 */
  dropTarget: DropTarget | null;
  setDropTarget: (t: DropTarget | null) => void;
  /** 添加 block —— 默认插到面积最大的叶子旁 */
  addBlock: (type: BlockType) => string | null;
  /** 移除 block(数据保留 / layout 树移除) */
  removeBlock: (blockId: string) => void;
  /** 交换两个 block 在 layout 树中的位置(swap leaves) */
  swapBlocks: (idA: string, idB: string) => void;
  /** 把 source block 移动到 target 的指定边/中心 —— 拖拽 release 时调 */
  moveBlock: (
    sourceId: string,
    targetId: string,
    side: DropSide,
    preserveRatio?: { sourceW: number; sourceH: number; targetW: number; targetH: number },
  ) => void;
  /** 改 split ratio(resize) */
  setRatioByPath: (path: ("L" | "R")[], ratio: number) => void;
  /** 更新某个 block 的 internal state(例:artifact 的 active / sidebar 折叠) */
  patchBlockState: (blockId: string, patch: Partial<ArtifactBlockState>) => void;
  /** 触发后端持久化(防抖) */
  scheduleSave: () => void;
}

const CanvasCtx = createContext<CanvasContextValue | null>(null);

export function CanvasProvider({
  initial,
  children,
}: {
  initial?: CanvasState | null;
  children: ReactNode;
}) {
  const [state, setState] = useState<CanvasState>(() => initial ?? readLocalCache() ?? defaultLayout());

  // 防抖保存
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      writeLocalCache(state);
      void persistToBackend(state);
    }, 800);
  }, [state]);

  useEffect(() => {
    writeLocalCache(state);
  }, [state]);

  // hydrate from initial 仅一次。后续 authPreferences 因为别的字段(theme/locale)
  // 变化而 re-render 不会复原 canvas state(否则用户拖了 block,patch 主题就回原)。
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    if (initial && initial.layout) {
      setState(initial);
      hydratedRef.current = true;
    } else if (initial === null || initial === undefined) {
      // initial 还没就绪(/me 还没回来),不算 hydrate
    } else {
      // initial 是个对象但 layout=null —— 视作 hydrate 完成,state 走默认
      hydratedRef.current = true;
    }
  }, [initial]);

  const visibleBlockIds = useMemo(() => collectLeaves(state.layout), [state.layout]);

  // state ref 给 closure(BlockShell pointermove 中实时查 layout)使用
  const stateRef = useRef<CanvasState>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // 全局 dragging 标志 —— canvas 根据它加 class 禁用其它 block 的 hover/click
  const [dragging, setDragging] = useState(false);
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const moveBlock = useCallback(
    (
      sourceId: string,
      targetId: string,
      side: DropSide,
      preserveRatio?: { sourceW: number; sourceH: number; targetW: number; targetH: number },
    ) => {
      setState((prev) => {
        if (!prev.layout) return prev;
        const newLayout = moveBlockToTarget(prev.layout, sourceId, targetId, side, preserveRatio);
        return { ...prev, layout: newLayout };
      });
    },
    [],
  );

  const addBlock = useCallback(
    (type: BlockType): string | null => {
      if (countLeaves(state.layout) >= MAX_BLOCKS) return null;
      const id = `blk_${cryptoId()}`;
      const block: Block = { id, type };
      const blockState: BlockState = type === "artifact" ? defaultArtifactState() : {};
      const newLayout = insertNewBlock(state.layout, id);
      const next: CanvasState = {
        blocks: { ...state.blocks, [id]: block },
        blockStates: { ...state.blockStates, [id]: blockState },
        layout: newLayout,
      };
      setState(next);
      // 立即保存(低频操作)
      writeLocalCache(next);
      void persistToBackend(next);
      return id;
    },
    [state],
  );

  const removeBlock = useCallback(
    (blockId: string) => {
      // 至少保留 1 个 block
      if (countLeaves(state.layout) <= 1) return;
      const newLayout = removeLeaf(state.layout, blockId);
      const newBlocks = { ...state.blocks };
      delete newBlocks[blockId];
      const newBlockStates = { ...state.blockStates };
      delete newBlockStates[blockId];
      const next: CanvasState = { blocks: newBlocks, blockStates: newBlockStates, layout: newLayout };
      setState(next);
      writeLocalCache(next);
      void persistToBackend(next);
    },
    [state],
  );

  const swapBlocks = useCallback((idA: string, idB: string) => {
    setState((prev) => {
      if (!prev.layout) return prev;
      const newLayout = swapLeaves(prev.layout, idA, idB);
      return { ...prev, layout: newLayout };
    });
  }, []);

  const setRatioByPath = useCallback((path: ("L" | "R")[], ratio: number) => {
    setState((prev) => {
      if (!prev.layout) return prev;
      return { ...prev, layout: updateRatioByPath(prev.layout, path, ratio) };
    });
  }, []);

  const patchBlockState = useCallback(
    (blockId: string, patch: Partial<ArtifactBlockState>) => {
      setState((prev) => {
        const oldS = (prev.blockStates[blockId] ?? {}) as ArtifactBlockState;
        const newS = { ...oldS, ...patch };
        return { ...prev, blockStates: { ...prev.blockStates, [blockId]: newS } };
      });
    },
    [],
  );

  const value = useMemo<CanvasContextValue>(
    () => ({
      state,
      stateRef,
      visibleBlockIds,
      dragging,
      setDragging,
      dragSourceId,
      setDragSourceId,
      dropTarget,
      setDropTarget,
      addBlock,
      removeBlock,
      swapBlocks,
      moveBlock,
      setRatioByPath,
      patchBlockState,
      scheduleSave,
    }),
    [state, stateRef, visibleBlockIds, dragging, dragSourceId, dropTarget, addBlock, removeBlock, swapBlocks, moveBlock, setRatioByPath, patchBlockState, scheduleSave],
  );

  return <CanvasCtx.Provider value={value}>{children}</CanvasCtx.Provider>;
}

export function useCanvas(): CanvasContextValue {
  const v = useContext(CanvasCtx);
  if (!v) throw new Error("useCanvas must be inside <CanvasProvider>");
  return v;
}

export { MAX_BLOCKS };
