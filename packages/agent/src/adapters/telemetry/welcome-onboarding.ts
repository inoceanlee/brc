import type { AgentConfigManager } from '../storage/config-manager.js';
import type { FeatureFlagManager } from '../network/feature-flags.js';

export interface WelcomeOnboardingDependencies {
  configManager: AgentConfigManager;
  featureFlagManager: FeatureFlagManager;
  hasFeature: (featureName: string) => Promise<boolean>;
  openWelcomePage: (clientName?: string) => Promise<unknown>;
  logToStderr: (level: 'debug' | 'info' | 'warning', message: string) => void;
  capture: (event: string, properties?: Record<string, unknown>) => Promise<unknown> | unknown;
}

/** Consume a pending welcome page when this client must never receive it. */
export async function skipWelcomePageOnboarding({ configManager, logToStderr }: WelcomeOnboardingDependencies): Promise<void> {
  const pending = await configManager.getValue('pendingWelcomeOnboarding');
  if (!pending) {
    return;
  }

  await configManager.setValue('pendingWelcomeOnboarding', false);
  logToStderr('debug', 'Welcome page skipped');
}

function isWelcomePageClientExcluded(featureFlagManager: FeatureFlagManager, clientName?: string): boolean {
  const configuredClients = featureFlagManager.get('welcome_page_excluded_clients', []);
  if (!Array.isArray(configuredClients) || !clientName) {
    return false;
  }

  const normalizedClientName = clientName.trim().toLowerCase();
  return configuredClients.some(
    (configuredClient) => typeof configuredClient === 'string'
      && configuredClient.trim().toLowerCase() === normalizedClientName
  );
}

/**
 * Handle welcome page display for new users (A/B test controlled)
 * 
 * Only shows to:
 * New users (pendingWelcomeOnboarding flag set when config created)
 * Users in the 'showOnboardingPage' A/B variant
 * Haven't seen it yet
 */
export async function handleWelcomePageOnboarding(deps: WelcomeOnboardingDependencies, clientName?: string): Promise<void> {
  const { configManager, featureFlagManager, hasFeature, openWelcomePage, logToStderr, capture } = deps;


  const eligible = await configManager.getValue('welcomeOnboardingEligible');
  if (!eligible) {
    return;
  }



  const pending = await configManager.getValue('pendingWelcomeOnboarding');
  if (!pending) {
    return; 
  }


  const loadedFromCache = featureFlagManager.wasLoadedFromCache();




  if (!loadedFromCache) {
    logToStderr('debug', 'Waiting for feature flags to load...');
    await featureFlagManager.waitForFreshFlags();
  }




  const enabled = featureFlagManager.get('welcome_page_enabled', true) !== false;
  if (!enabled) {
    await skipWelcomePageOnboarding(deps);
    return;
  }

  if (isWelcomePageClientExcluded(featureFlagManager, clientName)) {
    await skipWelcomePageOnboarding(deps);
    return;
  }


  const shouldShow = await hasFeature('showOnboardingPage');


  capture('server_welcome_page_ab_decision', {
    variant: shouldShow ? 'treatment' : 'control',
    loaded_from_cache: loadedFromCache
  });

  if (!shouldShow) {

    await configManager.setValue('sawOnboardingPage', false);
    await configManager.setValue('pendingWelcomeOnboarding', false);
    logToStderr('debug', 'Welcome page skipped (A/B: noOnboardingPage)');
    return;
  }


  const alreadyShown = await configManager.getValue('sawOnboardingPage');
  if (alreadyShown) {
    return;
  }

  try {
    await openWelcomePage(clientName);
    await configManager.setValue('sawOnboardingPage', true);
    await configManager.setValue('pendingWelcomeOnboarding', false);
    capture('server_welcome_page_opened', { success: true });
    logToStderr('info', 'Welcome page opened');
  } catch (e) {

    await configManager.setValue('pendingWelcomeOnboarding', false);
    capture('server_welcome_page_opened', { success: false, error: e instanceof Error ? e.message : String(e) });
    logToStderr('warning', `Failed to open welcome page: ${e instanceof Error ? e.message : e}`);
  }
}
