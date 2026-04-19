import { EventEmitter } from "events";

export interface TableChangeEvent {
  type:
    | "document:update"
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

export interface DocumentChangeEvent {
  type: "table:create" | "table:delete" | "table:reorder" | "table:rename"
    | "folder:create" | "folder:rename" | "folder:delete"
    | "item:move"
    | "design:create" | "design:rename" | "design:delete";
  documentId: string;
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

  emitDocumentChange(event: DocumentChangeEvent): void {
    const listeners = this.listenerCount(`document:${event.documentId}`);
    console.log(`[EventBus] ${event.type} doc=${event.documentId} client=${event.clientId} → ${listeners} subscriber(s)`);
    this.emit(`document:${event.documentId}`, event);
  }

  subscribeDocument(
    documentId: string,
    listener: (event: DocumentChangeEvent) => void,
  ): () => void {
    this.on(`document:${documentId}`, listener);
    return () => this.off(`document:${documentId}`, listener);
  }
}

export const eventBus = new TableEventBus();
