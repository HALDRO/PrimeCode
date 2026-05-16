import { useEffect, useRef } from 'react';
import { openCodeRuntime } from '../services/opencodeRuntime';
import { usePendingPermissions } from '../store';
import { useChatStore } from '../store/chatStore';
import { useUIStore } from '../store/uiStore';

export function useOpenCodeBootstrap(): void {
	const serverUrl = useUIStore(state => state.serverUrl);
	const workspaceRoot = useUIStore(state => state.workspaceRoot);
	const activeSessionId = useChatStore(state => state.activeSessionId);
	const pendingPermissions = usePendingPermissions();
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

	useEffect(() => {
		if (!activeSessionId || pendingPermissions.length === 0) return;
		const key = `${activeSessionId}:${pendingPermissions.map(permission => permission.id).join(',')}`;
		if (autoRespondKeyRef.current === key) return;
		autoRespondKeyRef.current = key;
		void openCodeRuntime
			.autoRespondPendingPermissions(activeSessionId)
			.catch(openCodeRuntime.showRuntimeError);
	}, [activeSessionId, pendingPermissions]);
}
