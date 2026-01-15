/**
 * @file PromptImproverHandler
 * @description Handles prompt improvement requests from webview.
 *              Uses PromptImproverService for AI-powered prompt enhancement.
 */

import { PromptImproverService } from '../../services/PromptImproverService';
import type { WebviewMessage } from '../../types';

// =============================================================================
// Types
// =============================================================================

export interface PromptImproverHandlerDeps {
	postMessage: (msg: unknown) => void;
}

// =============================================================================
// PromptImproverHandler Class
// =============================================================================

export class PromptImproverHandler {
	private readonly _service: PromptImproverService;

	constructor(private readonly _deps: PromptImproverHandlerDeps) {
		this._service = new PromptImproverService();
	}

	public async improvePrompt(message: WebviewMessage): Promise<void> {
		const { text, requestId, model, timeoutMs } = message;

		if (!text || !requestId) {
			return;
		}

		await this._service.improvePrompt(
			{
				requestId,
				text,
				model,
				timeoutMs,
			},
			result => {
				this._deps.postMessage({
					type: 'improvePromptResult',
					data: result,
				});
			},
			(reqId, error) => {
				this._deps.postMessage({
					type: 'improvePromptError',
					data: { requestId: reqId, error },
				});
			},
		);
	}

	public async cancelImprovement(message: WebviewMessage): Promise<void> {
		if (message.requestId) {
			await this._service.cancelImprovement(message.requestId);
			// Notify webview that cancellation was processed
			this._deps.postMessage({
				type: 'improvePromptCancelled',
				data: { requestId: message.requestId },
			});
		}
	}
}
