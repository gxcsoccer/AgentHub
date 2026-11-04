export type JsonObject = Record<string, unknown>;
export interface BridgeEvent {
  id: string;
  type: string;
  sessionId: string | null;
  turnId: string | null;
  timestamp: string;
  data: JsonObject;
}
export interface MessageInput {
  text: string;
  source: string;
  mode?: 'start' | 'steer';
  expectedTurnId?: string;
}
