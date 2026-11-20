
export const MCP_UI_EXPERIMENT_NAME = 'McpUiPreviews';
export const MCP_UI_SHOW_VARIANT = 'showMCPUi';
export const MCP_UI_HIDE_VARIANT = 'notShowMCPUi';

export interface McpUiPreviewDecisionDeps {
  getExistingAssignment: () => Promise<unknown>;
  isFirstRun: () => boolean;
  wasLoadedFromCache: () => boolean;
  waitForFreshFlags: () => Promise<void>;
  getABTestVariant: (experimentName: string) => Promise<string | null>;
  capture: (event: string, properties?: Record<string, unknown>) => Promise<unknown> | unknown;
}

function variantEnablesMcpUi(variant: unknown): boolean | null {
  if (variant === MCP_UI_HIDE_VARIANT) return false;
  if (variant === MCP_UI_SHOW_VARIANT) return true;
  return null;
}

export async function resolveMcpUiPreviewDecision(deps: McpUiPreviewDecisionDeps): Promise<boolean> {
  try {
    const existingAssignment = await deps.getExistingAssignment();
    const existingDecision = variantEnablesMcpUi(existingAssignment);
    if (existingDecision !== null) {
      if (!deps.wasLoadedFromCache()) {
        await deps.waitForFreshFlags();
      }

      const currentVariant = await deps.getABTestVariant(MCP_UI_EXPERIMENT_NAME);
      return variantEnablesMcpUi(currentVariant) ?? existingDecision;
    }

    if (!deps.isFirstRun()) {
      return true;
    }

    if (!deps.wasLoadedFromCache()) {
      await deps.waitForFreshFlags();
    }

    const variant = await deps.getABTestVariant(MCP_UI_EXPERIMENT_NAME);
    const decision = variantEnablesMcpUi(variant);
    if (decision === null) {
      return true;
    }

    try {
      await deps.capture('server_mcp_ui_ab_decision', {
        experiment: MCP_UI_EXPERIMENT_NAME,
        variant,
        mcp_ui_enabled: decision,
      });
    } catch {
    }

    return decision;
  } catch {
    return true;
  }
}

export async function shouldShowMcpUiPreviews(deps: McpUiPreviewDecisionDeps): Promise<boolean> {
  return resolveMcpUiPreviewDecision(deps);
}
