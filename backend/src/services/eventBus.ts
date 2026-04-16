import { EventEmitter } from "events";

export interface TableChangeEvent {
  type:
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
    | "view:delete";
  tableId: string;
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
}

export const eventBus = new TableEventBus();
