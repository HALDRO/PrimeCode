import { logger } from '../utils/logger';
import { CLIServiceFactory } from './CLIServiceFactory';

export interface ImprovePromptRequest {
	requestId: string;
	text: string;
	model?: string;
	timeoutMs?: number;
}

export interface ImprovePromptResult {
	requestId: string;
	improvedText: string;
}

export class PromptImproverService {
	private _activeRequests = new Set<string>();

	// Default template ensuring the output is ONLY the improved text and preserves language
	public static readonly DEFAULT_TEMPLATE =
		`You are an expert prompt engineer. Your task is to rewrite the user's prompt to be more clear, specific, and effective for an LLM coding assistant.

CRITICAL RULES:
1.  Preserve the original intent and all technical details.
2.  Do NOT add any conversational filler ("Here is the improved prompt:", "Sure!").
3.  Output ONLY the improved prompt text.
4.  **detect the language of the user's prompt and output the improved prompt in the SAME language.** (e.g. Russian -> Russian).

User Prompt:
{{TEXT}}`;

	public async improvePrompt(
		request: ImprovePromptRequest,
		onResult: (result: ImprovePromptResult) => void,
		onError: (requestId: string, error: string) => void,
	): Promise<void> {
		const { requestId, text, model, timeoutMs } = request;
		logger.info(`[PromptImprover] Starting improvement for ${requestId}`);

		// Track active request
		this._activeRequests.add(requestId);

		const config = await import('vscode').then(vscode =>
			vscode.workspace.getConfiguration('primeCode'),
		);
		const settingsTemplate =
			config.get<string>('promptImprove.template') || PromptImproverService.DEFAULT_TEMPLATE;

		// Correct logic: REPLACE placeholder, do not just append
		let prompt = settingsTemplate;
		if (prompt.includes('{{TEXT}}')) {
			prompt = prompt.replace('{{TEXT}}', text);
		} else {
			// Fallback if user messed up the template
			prompt = `${prompt}\n\nOriginal Input:\n${text}`;
		}

		const timeout = timeoutMs || config.get<number>('promptImprove.timeoutMs') || 60000;
		// Use request model if provided, otherwise check config
		const effectiveModel = model || config.get<string>('promptImprove.model');

		try {
			// Get CLI service from factory - it handles provider switching reactively
			const cliService = await CLIServiceFactory.getService();
			const providerType = cliService.getProviderType();
			logger.info(`[PromptImprover] Using CLI service: ${providerType}`);

			// Check if the service supports runSimplePrompt
			if (!cliService.runSimplePrompt) {
				throw new Error(
					`CLI service "${providerType}" does not support runSimplePrompt. Please update the service implementation.`,
				);
			}

			// Build proxy config using centralized factory method
			const proxyConfig = CLIServiceFactory.buildProxyConfig(effectiveModel, providerType);

			// Use the unified runSimplePrompt method
			const improvedText = await cliService.runSimplePrompt(prompt, {
				model: effectiveModel,
				timeoutMs: timeout,
				proxyConfig,
			});

			// Check if request was cancelled
			if (!this._activeRequests.has(requestId)) {
				logger.info(`[PromptImprover] Request ${requestId} was cancelled, ignoring result`);
				return;
			}

			if (!improvedText.trim()) {
				logger.warn('[PromptImprover] CLI returned empty response');
				onError(
					requestId,
					'CLI returned empty response. The model may not have generated any text.',
				);
				return;
			}

			logger.info(`[PromptImprover] Success, improved text length: ${improvedText.length}`);
			onResult({ requestId, improvedText });
		} catch (err) {
			// Check if request was cancelled
			if (!this._activeRequests.has(requestId)) {
				logger.info(`[PromptImprover] Request ${requestId} was cancelled, ignoring error`);
				return;
			}

			const msg = err instanceof Error ? err.message : String(err);
			logger.error(`[PromptImprover] Error: ${msg}`);

			if (msg.includes('not initialized') || msg.includes('not support')) {
				onError(requestId, msg);
			} else if (msg.includes('Timeout')) {
				onError(
					requestId,
					`Request timed out after ${timeout}ms. Try increasing the timeout in settings.`,
				);
			} else {
				onError(requestId, msg);
			}
		} finally {
			this._activeRequests.delete(requestId);
		}
	}

	public async cancelImprovement(requestId: string): Promise<void> {
		logger.info(`[PromptImprover] Cancelling ${requestId}`);
		this._activeRequests.delete(requestId);
		// Note: The actual CLI request may still complete, but we'll ignore the result
	}

	/**
	 * Dispose of resources.
	 */
	public async dispose(): Promise<void> {
		this._activeRequests.clear();
	}
}
