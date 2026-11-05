import type { SessionAddress } from '../types.js';

export interface ProcessIdentity {
  pid: number;
  ppid: number;
  uid: number;
  start: string;
}
export type ProcessInspector = (pid: number) => Promise<ProcessIdentity>;
export interface ClaudeConnectorEvidence {
  pid: number;
  startupSessionId: string;
  transport?: 'cli';
}
export interface CodexConnectorEvidence {
  harness: 'codex';
  pid: number;
  threadId: string;
  sessionId?: string;
  connectionId: string;
}
export type ConnectorEvidence = ClaudeConnectorEvidence | CodexConnectorEvidence;
export interface ConnectorProfile {
  id: string;
  callerId: string;
  harness: 'claude' | 'codex';
  instance: string;
  enrollmentToken: string;
  epoch?: number;
  enabled?: boolean;
  mcpServerName?: string;
  transport?: 'mcp' | 'cli';
}
export interface ConnectorBinding {
  bindingId: string;
  profileId: string;
  address: SessionAddress;
  createdAt: string;
  connectionId?: string;
}
export interface ConnectorAsk {
  messageId: string;
  to: SessionAddress | string;
  message: string;
  expiresAt: string;
}
export interface ConnectorReply {
  request: string;
  message: string;
}

export interface ConnectorConnectionResult {
  address: SessionAddress;
  changed: boolean;
  reloaded: boolean;
  activationScope: 'instance' | 'session';
  activationId?: string;
  phase: 'ready' | 'awaiting_identity' | 'awaiting_connection';
  exitCode: 0 | 2;
  checkedAt: string;
  verificationMethod:
    | 'native_mcp_readonly_call'
    | 'native_connection_and_prior_binding'
    | 'native_peer_cli_handshake';
  capabilities: { toolsConnected: boolean; identityBound: boolean; cliVerified?: boolean };
  reason: string;
  nextAction: string | null;
}
