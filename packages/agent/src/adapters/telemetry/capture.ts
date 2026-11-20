import { platform } from 'os';
import * as https from 'https';
import { AsyncLocalStorage } from 'async_hooks';
import { isTelemetryDisabledValue } from '../storage/config-manager.js';
import type { AgentConfigManager } from '../storage/config-manager.js';
import type { getSystemInfo } from '../system/system-info.js';

export type Capture = (event: string, properties?: unknown) => Promise<void>;

export interface CaptureDependencies {
    env: NodeJS.ProcessEnv;
    configManager: AgentConfigManager;
    getContext: () => {
        currentClient: { name: string; version: string } | null | undefined;
        currentCallIsRemote: boolean;
        currentRemoteClient: { name?: string; version?: string } | null | undefined;
    };
    getSystemInfo: typeof getSystemInfo;
}







const uiOriginCallContext = new AsyncLocalStorage<boolean>();

export function runInUiOriginCallContext<T>(fn: () => T): T {
    return uiOriginCallContext.run(true, fn);
}

export function isInsideUiOriginCall(): boolean {
    return uiOriginCallContext.getStore() === true;
}

let VERSION = 'unknown';
try {
    const versionModule = await import('../../core/version.js');
    VERSION = versionModule.VERSION;
} catch {
    // Continue without version info if not available
}








const TELEMETRY_PROXY_URL = 'https://telemetry.desktopcommander.app/mp/collect';
const TELEMETRY_PROXY_FALLBACK_URL = 'https://dc-telemetry-proxy-83847352264.europe-west1.run.app/mp/collect';

/**
 * Hard kill-switch for telemetry via environment variable.
 *
 * Independent of the persisted `telemetryEnabled` config so that tests, CI and
 * one-off runs can suppress all analytics without mutating the user's config.
 * Set DESKTOP_COMMANDER_DISABLE_TELEMETRY to 1/true/yes/on to disable.
 */
export function isTelemetryDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
    
    if (!['1', 'true'].includes((env.BRC_UPSTREAM_TELEMETRY ?? '').toLowerCase())) return true;
    const raw = env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
    if (!raw) return false;
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}


/**
 * Sanitizes error objects to remove potentially sensitive information like file paths
 * @param error Error object or string to sanitize
 * @returns An object with sanitized message and optional error code
 */
export function sanitizeError(error: any): { message: string, code?: string } {
    let errorMessage = '';
    let errorCode = undefined;

    if (error instanceof Error) {
        
        errorMessage = error.name + ': ' + error.message;

        
        if ('code' in error) {
            errorCode = (error as any).code;
        }
    } else if (typeof error === 'string') {
        errorMessage = error;
    } else {
        errorMessage = 'Unknown error';
    }

    
    
    errorMessage = errorMessage.replace(/(?:\/|\\)[\w\d_.-\/\\]+/g, '[PATH]');
    errorMessage = errorMessage.replace(/[A-Za-z]:\\[\w\d_.-\/\\]+/g, '[PATH]');

    return {
        message: errorMessage,
        code: errorCode
    };
}


export function createCapture({ configManager, getContext, getSystemInfo, env }: CaptureDependencies) {
let uniqueUserId = 'unknown';

/**
 * Build the standard event properties used by the telemetry proxy.
 * Centralize telemetry event sanitization for the supported capture path.
 */
const buildEventProperties = async (properties?: any) => {
    const { currentClient, currentCallIsRemote, currentRemoteClient } = getContext();
    if (uniqueUserId === 'unknown') {
        uniqueUserId = await configManager.getOrCreateClientId();
    }

    
    
    const effectiveClient =
        currentCallIsRemote && currentRemoteClient ? currentRemoteClient : currentClient;
    let clientContext: any = {};
    if (effectiveClient) {
        clientContext = {
            client_name: effectiveClient.name,
            client_version: effectiveClient.version,
        };
    }

    const sawOnboardingPage = await configManager.getValue('sawOnboardingPage');
    if (sawOnboardingPage !== undefined) {
        clientContext.saw_onboarding_page = sawOnboardingPage;
    }

    let sanitizedProperties: any;
    try {
        sanitizedProperties = properties ? JSON.parse(JSON.stringify(properties)) : {};
    } catch {
        sanitizedProperties = {};
    }

    if (sanitizedProperties.error) {
        if (typeof sanitizedProperties.error === 'object' && sanitizedProperties.error !== null) {
            const sanitized = sanitizeError(sanitizedProperties.error);
            sanitizedProperties.error = sanitized.message;
            if (sanitized.code) sanitizedProperties.errorCode = sanitized.code;
        } else if (typeof sanitizedProperties.error === 'string') {
            sanitizedProperties.error = sanitizeError(sanitizedProperties.error).message;
        }
    }

    const sensitiveKeys = ['path', 'filePath', 'directory', 'file_path', 'sourcePath', 'destinationPath', 'fullPath', 'rootPath'];
    for (const key of Object.keys(sanitizedProperties)) {
        const lowerKey = key.toLowerCase();
        if (sensitiveKeys.some(sk => lowerKey.includes(sk)) && lowerKey !== 'fileextension') {
            delete sanitizedProperties[key];
        }
    }

    let isDXT = 'false';
    if (env.MCP_DXT) isDXT = 'true';

    const systemInfo = getSystemInfo();
    const isContainer = systemInfo.docker.isContainer ? 'true' : 'false';
    const containerType = systemInfo.docker.containerType || 'none';
    const orchestrator = systemInfo.docker.orchestrator || 'none';

    let containerName = 'none';
    let containerImage = 'none';
    if (systemInfo.docker.isContainer && systemInfo.docker.containerEnvironment) {
        const env = systemInfo.docker.containerEnvironment;
        if (env.containerName) {
            containerName = env.containerName
                .replace(/[0-9a-f]{8,}/gi, 'ID')
                .replace(/[0-9]{8,}/g, 'ID')
                .substring(0, 50);
        }
        if (env.dockerImage) {
            containerImage = env.dockerImage
                .replace(/^[^/]+\/[^/]+\//, '')
                .replace(/^[^/]+\//, '')
                .replace(/@sha256:.*$/, '')
                .substring(0, 100);
        }
    }

    let runtimeSource = 'unknown';
    try {
        const processArgs = process.argv.join(' ');
        if (processArgs.includes('@smithery/cli') || processArgs.includes('smithery')) {
            runtimeSource = 'smithery-runtime';
        } else if (processArgs.includes('npx')) {
            runtimeSource = 'npx-runtime';
        } else {
            runtimeSource = 'direct-runtime';
        }
    } catch { }

    return {
        timestamp: new Date().toISOString(),
        platform: platform(),
        isContainer,
        containerType,
        orchestrator,
        containerName,
        containerImage,
        runtimeSource,
        isDXT,
        app_version: VERSION,
        engagement_time_msec: "100",
        ...clientContext,
        
        
        
        ...(currentCallIsRemote ? { remote: String(true) } : {}),
        ...sanitizedProperties,
    };
};

/**
 * Send event to the telemetry proxy (direct BigQuery ingestion).
 * Uses the custom domain first and retries the generated Cloud Run URL on failure.
 */
const sendToTelemetryProxy = async (event: string, eventProperties: any) => {
    try {
        if (isTelemetryDisabledByEnv(env)) return;
        const telemetryEnabled = await configManager.getValue('telemetryEnabled');
        if (isTelemetryDisabledValue(telemetryEnabled)) return;

        const payload = JSON.stringify({
            client_id: uniqueUserId,
            timestamp_micros: Date.now() * 1000,
            events: [{
                name: event,
                params: eventProperties
            }]
        });

        const sent = await postTelemetryPayload(TELEMETRY_PROXY_URL, payload);
        if (!sent) {
            await postTelemetryPayload(TELEMETRY_PROXY_FALLBACK_URL, payload);
        }
    } catch {
        // Silent fail — telemetry should never break functionality
    }
};

const postTelemetryPayload = async (endpoint: string, payload: string): Promise<boolean> => {
    return await new Promise((resolve) => {
        const url = new URL(endpoint);
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300));
        });
        req.on('error', () => resolve(false));
        req.setTimeout(3000, () => {
            req.destroy();
            resolve(false);
        });
        req.write(payload);
        req.end();
    });
};






const capture = async (event: string, properties?: unknown) => {
    if (isTelemetryDisabledByEnv(env)) return;
    
    
    if (isInsideUiOriginCall()) {
        return;
    }
    void (async () => {
        try {
            const eventProperties = await buildEventProperties(properties);
            await sendToTelemetryProxy(event, eventProperties);
        } catch {
            // Silent fail — telemetry should never break functionality
        }
    })();
}

const capture_call_tool = capture;
const capture_ui_event = capture;

/**
 * Wrapper for capture() that automatically adds remote flag for remote-device telemetry
 * Also adds additional privacy filtering to remove sensitive identity information
 * @param event Event name
 * @param properties Optional event properties
 */
const captureRemote = async (event: string, properties?: Record<string, unknown>) => {
    
    const sanitizedProps = properties ? { ...properties } : {};

    
    const sensitiveIdentityKeys = ['deviceId', 'userId', 'email', 'user_id', 'device_id', 'user_email'];
    for (const key of sensitiveIdentityKeys) {
        if (key in sanitizedProps) {
            delete sanitizedProps[key];
        }
    }

    return await capture(event, {
        ...sanitizedProps,
        remote: String(true)
    });
}

return { capture, capture_call_tool, capture_ui_event, captureRemote };
}
