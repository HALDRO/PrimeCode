import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentResource, ExtensionMessage } from '../../../common/protocol';
import { useSettingsStore } from '../settingsStore';

const makeAgent = (name: string): AgentResource => ({
	id: `agent:runtime:${name}`,
	kind: 'agent',
	name,
	source: 'runtime',
	sourceKind: 'custom',
	hasProjectOverride: false,
	disabled: false,
});

const resourcesList = (revision: number, resources: AgentResource[]): ExtensionMessage => ({
	type: 'resourcesList',
	data: {
		kind: 'agent',
		resources,
		revision,
	},
});

describe('settingsStore resource revisions', () => {
	beforeEach(() => {
		useSettingsStore.setState({
			resources: {
				...useSettingsStore.getState().resources,
				agent: { items: [], revision: 0, isLoading: false, error: undefined },
			},
		});
	});

	it('ignores stale resourcesList revisions', () => {
		const actions = useSettingsStore.getState().actions;

		actions.handleExtensionMessage(resourcesList(2, [makeAgent('build')]));
		actions.handleExtensionMessage(resourcesList(1, [makeAgent('stale')]));

		const state = useSettingsStore.getState().resources.agent;
		expect(state.revision).toBe(2);
		expect(state.items.map(item => item.name)).toEqual(['build']);
	});

	it('treats stale resource operations as non-successful', () => {
		const actions = useSettingsStore.getState().actions;

		actions.handleExtensionMessage({
			type: 'resourceOperation',
			data: {
				operationId: 'op-1',
				resourceId: 'agent:runtime:review',
				action: 'setDisabled',
				status: 'completed',
				result: 'stale',
				message: 'OpenCode did not reflect the refreshed state.',
			},
		});

		const state = useSettingsStore.getState().resourceOps;
		expect(state.status).toBe('error');
		expect(state.message).toBe('OpenCode did not reflect the refreshed state.');
	});
});
