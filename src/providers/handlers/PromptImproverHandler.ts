import { PromptImproverService } from '../../services/PromptImproverService';
import type { WebviewMessage } from '../../types';

export class PromptImproverHandler {
	private readonly _service: PromptImproverService;

	constructor() {
		this._service = new PromptImproverService();
	}

	public async improvePrompt(
		message: WebviewMessage,
		postMessage: (msg: unknown) => void,
	): Promise<void> {
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
				postMessage({
					type: 'improvePromptResult',
					data: result,
				});
			},
			(reqId, error) => {
				postMessage({
					type: 'improvePromptError',
					data: { requestId: reqId, error },
				});
			},
		);
	}

	public async cancelImprovement(
		message: WebviewMessage,
		postMessage: (msg: unknown) => void,
	): Promise<void> {
		if (message.requestId) {
			await this._service.cancelImprovement(message.requestId);
			// Notify webview that cancellation was processed
			postMessage({
				type: 'improvePromptCancelled',
				data: { requestId: message.requestId },
			});
		}
	}
}
