/**
 * @file OpenCode bootstrap hook
 * @description Initializes OpenCode runtime connection and manages automatic permission
 *              responses. Reacts to pending permissions, session auto-accept toggles,
 *              global accessAutoApprove, and per-tool always-allow list to immediately
 *              resolve permissions that match PrimeCode-only overrides.
 *              Per-category policies are handled server-side via opencode.json.
 */

import { useEffect, useRef } from 'react';
import { openCodeRuntime } from '../services/opencodeRuntime';
import { usePendingPermissions } from '../store';
import { useChatStore } from '../store/chatStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';

export function useOpenCodeBootstrap(): void {
	const serverUrl = useUIStore(state => state.serverUrl);
	const workspaceRoot = useUIStore(state => state.workspaceRoot);
	const activeSessionId = useChatStore(state => state.activeSessionId);
	const pendingPermissions = usePendingPermissions();
	const sessionAutoAccept = useChatStore(
		state =>
			(state.activeSessionId ? state.sessionAutoAccept[state.activeSessionId] : undefined) ?? false,
	);
	const accessAutoApprove = useSettingsStore(state => state.accessAutoApprove);
	const access = useSettingsStore(state => state.access);

	const bootstrapKeyRef = useRef<string | null>(null);
	const autoRespondKeyRef = useRef<string | null>(null);

	useEffect(() => {
		if (!serverUrl || !workspaceRoot) return;
		const key = `${serverUrl}:${workspaceRoot}`;
		if (bootstrapKeyRef.current === key) return;
		bootstrapKeyRef.current = key;
		void openCodeRuntime.bootstrap();
	}, [serverUrl, workspaceRoot]);

	useEffect(() => {
		const onNewSession = () => {
			void openCodeRuntime.createSession().catch(openCodeRuntime.showRuntimeError);
		};
		window.addEventListener('primecode:new-session', onNewSession);
		return () => window.removeEventListener('primecode:new-session', onNewSession);
	}, []);

	// Auto-respond to pending permissions when PrimeCode-only overrides apply:
	// - new permissions arrive while auto-accept/accessAutoApprove/always-allow is active
	// - auto-accept is toggled on for the session
	// - global accessAutoApprove changes
	// - access list (always-allow by tool) changes
	useEffect(() => {
		if (!activeSessionId || pendingPermissions.length === 0) return;
		const key = [
			activeSessionId,
			pendingPermissions.map(p => p.id).join(','),
			String(sessionAutoAccept),
			String(accessAutoApprove),
			(access ?? []).map(a => `${a.toolName}:${a.allowAll}`).join(','),
		].join('|');
		if (autoRespondKeyRef.current === key) return;
		autoRespondKeyRef.current = key;
		void openCodeRuntime
			.autoRespondPendingPermissions(activeSessionId)
			.catch(openCodeRuntime.showRuntimeError);
	}, [activeSessionId, pendingPermissions, sessionAutoAccept, accessAutoApprove, access]);
}
