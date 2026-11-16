/** BRC agent library entry. */
export * from './context.js';
export { callTool, listTools, hasTool } from './adapters/mcp/dispatcher.js';
export { WsClient, type WsClientOptions } from './adapters/transport/ws-client.js';
export { configManager } from './adapters/storage/config-manager.js';
export { configureAgentServices } from './composition.js';
export { VERSION as CORE_VERSION } from './core/version.js';
