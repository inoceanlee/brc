import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import type { AgentLogger } from '../telemetry/logger.js';

interface FeatureFlags {
  version?: string;
  flags?: Record<string, any>;
}

export class FeatureFlagManager {
  private flags: Record<string, any> = {};
  private lastFetch: number = 0;
  private cachePath: string;
  private cacheMaxAge: number = 30 * 60 * 1000;
  private flagUrl: string;
  private refreshInterval: NodeJS.Timeout | null = null;
  
  
  private freshFetchPromise: Promise<void> | null = null;
  private resolveFreshFetch: (() => void) | null = null;
  private loadedFromCache: boolean = false;

  constructor(cachePath: string, private readonly logger: AgentLogger, env: NodeJS.ProcessEnv) {
    this.cachePath = cachePath;
    
    
    this.flagUrl = env.DC_FLAG_URL ||
      'https://desktopcommander.app/flags/v2/production.json';
    
    
    this.freshFetchPromise = new Promise((resolve) => {
      this.resolveFreshFetch = resolve;
    });
  }

  /**
   * Initialize - load from cache and start background refresh
   */
  async initialize(): Promise<void> {
    try {
      
      await this.loadFromCache();
      
      
      this.fetchFlags().then(() => {
        
        if (this.resolveFreshFetch) {
          this.resolveFreshFetch();
        }
      }).catch(err => {
        this.logger.debug('Initial flag fetch failed:', err.message);
        
        if (this.resolveFreshFetch) {
          this.resolveFreshFetch();
        }
      });
      
      
      this.refreshInterval = setInterval(() => {
        this.fetchFlags().catch(err => {
          this.logger.debug('Periodic flag fetch failed:', err.message);
        });
      }, this.cacheMaxAge);
      
      
      
      this.refreshInterval.unref();
      
      this.logger.info(`Feature flags initialized (refresh every ${this.cacheMaxAge / 1000}s)`);
    } catch (error) {
      this.logger.warning('Failed to initialize feature flags:', error);
    }
  }

  /**
   * Get a flag value
   */
  get(flagName: string, defaultValue: any = false): any {
    return this.flags[flagName] !== undefined ? this.flags[flagName] : defaultValue;
  }

  /**
   * Get all flags for debugging
   */
  getAll(): Record<string, any> {
    return { ...this.flags };
  }

  /**
   * Manually refresh flags immediately (for testing)
   */
  async refresh(): Promise<boolean> {
    try {
      await this.fetchFlags();
      return true;
    } catch (error) {
      this.logger.error('Manual refresh failed:', error);
      return false;
    }
  }

  /**
   * Check if flags were loaded from cache (vs fresh fetch)
   */
  wasLoadedFromCache(): boolean {
    return this.loadedFromCache;
  }

  /**
   * Wait for fresh flags to be fetched from network.
   * Use this when you need to ensure flags are loaded before making decisions
   * (e.g., A/B test assignments for new users who don't have a cache yet)
   * 
   * Has a hard timeout to prevent blocking MCP startup if the fetch hangs.
   * See: https://github.com/wonderwhy-er/DesktopCommanderMCP/issues/465
   */
  async waitForFreshFlags(): Promise<void> {
    if (this.freshFetchPromise) {
      let safetyTimeoutHandle: NodeJS.Timeout | undefined;
      try {
        const safetyTimeout = new Promise<void>((resolve) => {
          safetyTimeoutHandle = setTimeout(resolve, 5000);
        });
        await Promise.race([this.freshFetchPromise, safetyTimeout]);
      } finally {
        if (safetyTimeoutHandle) {
          clearTimeout(safetyTimeoutHandle);
        }
      }
    }
  }

  /**
   * Load flags from local cache
   */
  private async loadFromCache(): Promise<void> {
    try {
      if (!existsSync(this.cachePath)) {
        this.logger.debug('No feature flag cache found');
        this.loadedFromCache = false;
        return;
      }

      const data = await fs.readFile(this.cachePath, 'utf8');
      const config: FeatureFlags = JSON.parse(data);
      
      if (config.flags) {
        this.flags = config.flags;
        this.lastFetch = Date.now();
        this.loadedFromCache = true;
        this.logger.debug(`Loaded ${Object.keys(this.flags).length} feature flags from cache`);
      }
    } catch (error) {
      this.logger.warning('Failed to load feature flags from cache:', error);
      this.loadedFromCache = false;
    }
  }

  /**
   * Fetch flags from remote URL
   */
  private async fetchFlags(): Promise<void> {
    const FETCH_TIMEOUT_MS = 3000;
    const controller = new AbortController();
    const abortTimeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let hardTimeoutHandle: NodeJS.Timeout | undefined;

    try {
      

      
      
      
      
      
      
      const fetchPromise = fetch(this.flagUrl, {
        signal: controller.signal,
        headers: {
          'Cache-Control': 'no-cache',
        }
      });
      const hardTimeout = new Promise<never>((_, reject) =>
        hardTimeoutHandle = setTimeout(
          () => reject(new Error('Feature flags fetch timed out')),
          FETCH_TIMEOUT_MS
        )
      );

      const response = await Promise.race([fetchPromise, hardTimeout]);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const config: FeatureFlags = await response.json();
      
      
      if (config.flags) {
        this.flags = config.flags;
        this.lastFetch = Date.now();
        
        
        
        await this.saveToCache(config);
      }
    } catch (error: any) {
      this.logger.debug('Failed to fetch feature flags:', error.message);
      // Continue with cached values
    } finally {
      clearTimeout(abortTimeout);
      if (hardTimeoutHandle) {
        clearTimeout(hardTimeoutHandle);
      }
    }
  }

  /**
   * Save flags to local cache
   */
  private async saveToCache(config: FeatureFlags): Promise<void> {
    try {
      const configDir = path.dirname(this.cachePath);
      if (!existsSync(configDir)) {
        await fs.mkdir(configDir, { recursive: true });
      }
      
      await fs.writeFile(this.cachePath, JSON.stringify(config, null, 2), 'utf8');
      // Don't log here - this runs async and can cause issues with MCP clients
    } catch (error) {
      this.logger.warning('Failed to save feature flags to cache:', error);
    }
  }

  /**
   * Cleanup on shutdown
   */
  destroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }
}

