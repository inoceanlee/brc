import { AgentConfigManager, attachConfigManager } from './adapters/storage/config-manager.js';
import { FeatureFlagManager, attachFeatureFlagManager } from './adapters/network/feature-flags.js';
import { SearchManager, attachSearchManager } from './adapters/system/search-manager.js';
import { CommandManager, attachCommandManager } from './adapters/terminal/command-manager.js';
import { TerminalManager, attachTerminalManager } from './adapters/terminal/terminal-manager.js';
import { ToolHistory, attachToolHistory } from './adapters/telemetry/toolHistory.js';
import { UsageTracker, attachUsageTracker } from './adapters/telemetry/usageTracker.js';
import { FuzzySearchLogger, attachFuzzySearchLogger } from './adapters/telemetry/fuzzySearchLogger.js';

let configured = false;

export function configureAgentServices(): void {
  if (configured) return;
  attachConfigManager(new AgentConfigManager());
  attachFeatureFlagManager(new FeatureFlagManager());
  attachCommandManager(new CommandManager());
  attachTerminalManager(new TerminalManager());
  attachSearchManager(new SearchManager());
  attachToolHistory(new ToolHistory());
  attachUsageTracker(new UsageTracker());
  attachFuzzySearchLogger(new FuzzySearchLogger());
  configured = true;
}
