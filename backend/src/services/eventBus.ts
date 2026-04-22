import { EventEmitter } from "events";

export interface TableChangeEvent {
  type:
    | "workspace:update"
    | "table:update"
    | "record:create"
    | "record:update"
    | "record:delete"
    | "record:batch-delete"
    | "record:batch-create"
    | "field:create"
    | "field:update"
    | "field:delete"
    | "field:batch-delete"
    | "field:batch-restore"
    | "view:create"
    | "view:update"
    | "view:delete"
    | "full-sync";
  tableId: string;
  clientId: string;
  timestamp: number;
  payload: Record<string, any>;
}

export interface WorkspaceChangeEvent {
  type: "table:create" | "table:delete" | "table:reorder" | "table:rename"
    | "folder:create" | "folder:rename" | "folder:delete" | "folder:reorder"
    | "item:move"
    | "design:create" | "design:rename" | "design:delete" | "design:reorder"
    | "idea:create" | "idea:rename" | "idea:delete" | "idea:reorder";
  workspaceId: string;
  clientId: string;
  timestamp: number;
  payload: Record<string, any>;
}

export interface IdeaChangeEvent {
  type:
    | "idea:content-change"
    | "idea:rename"
    // V2 streaming write protocol (Agent-driven token-level writes).
    // - begin: editor should enter soft-lock, record anchor offset, suspend autosave.
    // - delta: splice an incremental chunk of text at (anchor offset + buffered length).
    // - finalize: replace local buffer with authoritative content + new version, resume autosave.
    | "idea:stream-begin"
    | "idea:stream-delta"
    | "idea:stream-finalize";
  ideaId: string;
  clientId: string;
  timestamp: number;
  payload: Record<string, any>;
}

class TableEventBus extends EventEmitter {
  emitChange(event: TableChangeEvent): void {
    const listeners = this.listenerCount(`table:${event.tableId}`);
    console.log(`[EventBus] ${event.type} client=${event.clientId} → ${listeners} subscriber(s)`);
    this.emit(`table:${event.tableId}`, event);
  }

  subscribe(
    tableId: string,
    listener: (event: TableChangeEvent) => void,
  ): () => void {
    this.on(`table:${tableId}`, listener);
    return () => this.off(`table:${tableId}`, listener);
  }

  emitWorkspaceChange(event: WorkspaceChangeEvent): void {
    const listeners = this.listenerCount(`workspace:${event.workspaceId}`);
    console.log(`[EventBus] ${event.type} ws=${event.workspaceId} client=${event.clientId} → ${listeners} subscriber(s)`);
    this.emit(`workspace:${event.workspaceId}`, event);
  }

  subscribeWorkspace(
    workspaceId: string,
    listener: (event: WorkspaceChangeEvent) => void,
  ): () => void {
    this.on(`workspace:${workspaceId}`, listener);
    return () => this.off(`workspace:${workspaceId}`, listener);
  }

  emitIdeaChange(event: IdeaChangeEvent): void {
    const listeners = this.listenerCount(`idea:${event.ideaId}`);
    console.log(`[EventBus] ${event.type} idea=${event.ideaId} client=${event.clientId} → ${listeners} subscriber(s)`);
    this.emit(`idea:${event.ideaId}`, event);
  }

  subscribeIdea(
    ideaId: string,
    listener: (event: IdeaChangeEvent) => void,
  ): () => void {
    this.on(`idea:${ideaId}`, listener);
    return () => this.off(`idea:${ideaId}`, listener);
  }
}

export const eventBus = new TableEventBus();
