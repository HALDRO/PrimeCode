/**
 * @file Shared hook for access request responses
 * @description Centralizes the permission response logic used by AccessGate (inside ToolCards).
 *              Sends the unified accessResponse message and optimistically updates the store.
 */

import { useCallback } from 'react';
import { useSessionMessage } from '../utils/vscode';

type AccessResponseType = 'once' | 'always' | 'reject';

interface UseAccessResponseOptions {
	requestId: string;
	tool: string;
	messageId?: string;
}

/**
 * Hook that returns a single `respond` function for access requests.
 *
 * @example
 * const respond = useAccessResponse({ requestId, tool, messageId });
 * respond(true);          // allow once
 * respond(true, true);    // always allow
 * respond(false);         // deny
 */
export function useAccessResponse({ requestId, tool, messageId }: UseAccessResponseOptions) {
	const { postSessionMessage } = useSessionMessage();

	return useCallback(
		(isApproved: boolean, alwaysAllow = false) => {
			const response: AccessResponseType = isApproved
				? alwaysAllow
					? 'always'
					: 'once'
				: 'reject';

			postSessionMessage({
				type: 'accessResponse',
				id: requestId,
				toolName: tool,
				approved: isApproved,
				alwaysAllow,
				response,
			});
			void messageId;
		},
		[requestId, tool, messageId, postSessionMessage],
	);
}
