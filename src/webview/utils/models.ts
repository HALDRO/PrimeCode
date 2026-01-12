export interface ModelInfo {
	id: string;
	name: string;
	contextWindow: number;
	maxOutput?: number;
}

export const STANDARD_MODELS: ModelInfo[] = [
	{
		id: 'claude-sonnet-4-5',
		name: 'Claude Sonnet 4.5',
		contextWindow: 200000,
	},
	{
		id: 'claude-haiku-4-5',
		name: 'Claude Haiku 4.5',
		contextWindow: 200000,
	},
	{
		id: 'claude-opus-4-5',
		name: 'Claude Opus 4.5',
		contextWindow: 200000,
	},
];

export const DEFAULT_CONTEXT_WINDOW = 200000;

// Store for dynamic model context windows from providers
let providerContextWindows: Map<string, number> = new Map();

/**
 * Update context window data from OpenCode providers
 * Called when providers are loaded
 */
export const updateProviderContextWindows = (
	providers: Array<{
		id: string;
		models: Array<{ id: string; limit?: { context?: number } }>;
	}>,
): void => {
	providerContextWindows = new Map();
	for (const provider of providers) {
		for (const model of provider.models) {
			const fullId = `${provider.id}/${model.id}`;
			if (model.limit?.context) {
				providerContextWindows.set(fullId, model.limit.context);
			}
		}
	}
};

export const getModelContextWindow = (modelId: string): number => {
	// First check provider data (from CLI)
	const providerContext = providerContextWindows.get(modelId);
	if (providerContext) {
		return providerContext;
	}

	// Then check standard models
	const model = STANDARD_MODELS.find(m => m.id === modelId);
	if (model) {
		return model.contextWindow;
	}

	// Default fallback
	return DEFAULT_CONTEXT_WINDOW;
};
