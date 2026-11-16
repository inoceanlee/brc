import { AsyncLocalStorage } from 'node:async_hooks';

export interface AgentCallContext {
  currentClient: { name: string; version: string };
  currentCallIsRemote: boolean;
  currentRemoteClient: { name?: string; version?: string } | null;
}

export class AgentContext {
  private readonly calls = new AsyncLocalStorage<AgentCallContext>();

  constructor(private readonly currentClient: AgentCallContext['currentClient']) {}

  current(): AgentCallContext {
    return this.calls.getStore() ?? {
      currentClient: this.currentClient,
      currentCallIsRemote: false,
      currentRemoteClient: null,
    };
  }

  runRemote<T>(client: AgentCallContext['currentRemoteClient'], operation: () => T): T {
    return this.calls.run({ currentClient: this.currentClient, currentCallIsRemote: true, currentRemoteClient: client }, operation);
  }
}
