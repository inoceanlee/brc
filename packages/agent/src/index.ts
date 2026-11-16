/** BRC agent library entry. */
export * from './context.js';
export { createToolDispatcher } from './adapters/mcp/dispatcher.js';
export { WsClient, type WsClientOptions } from './adapters/transport/ws-client.js';
export { VERSION as CORE_VERSION } from './core/version.js';
