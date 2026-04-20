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
    | "design:create" | "design:rename" | "design:delete" | "design:reorder";
  workspaceId: string;
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
}

export const eventBus = new TableEventBus();
