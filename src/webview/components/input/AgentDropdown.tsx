/**
 * @file AgentDropdown - Agent selector dropdown
 * @description Allows switching between primary CLI agents (build, plan, custom).
 *              Uses DropdownMenu with standard item fields (icon, description)
 *              for consistent styling — no custom renderItem needed.
 */

import type React from 'react';
import { useCallback, useMemo } from 'react';
import { useSettingsStore } from '../../store';
import { AgentsIcon, BotIcon, PlanIcon } from '../icons';
import { DropdownMenu, type DropdownMenuItem } from '../ui';

interface AgentData {
	id: string;
}

/** Resolve icon for a given agent id. */
function getAgentIcon(agentId: string, size = 14) {
	switch (agentId) {
		case 'build':
			return <AgentsIcon size={size} />;
		case 'plan':
			return <PlanIcon size={size} />;
		default:
			return <BotIcon size={size} />;
	}
}

/** Resolve display label for a given agent id (supports hyphenated names like 'custom-agent'). */
function getAgentLabel(agentId: string | undefined): string {
	if (!agentId || agentId === 'build') return 'Build';
	return agentId
		.split('-')
		.map(word => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

interface AgentDropdownProps {
	anchorElement?: HTMLElement | null;
	onSelect: (agent: string | undefined) => void;
	onClose: () => void;
}

/** Resolve the current agent icon for the toolbar button. */
export function AgentButtonIcon({
	agentId,
	size = 14,
	className,
}: {
	agentId: string | undefined;
	size?: number;
	className?: string;
}) {
	const id = agentId || 'build';
	return <span className={className}>{getAgentIcon(id, size)}</span>;
}

export { getAgentLabel };

export const AgentDropdown: React.FC<AgentDropdownProps> = ({
	anchorElement,
	onSelect,
	onClose,
}) => {
	const agents = useSettingsStore(state => state.agents);

	const items = useMemo<DropdownMenuItem<AgentData>[]>(() => {
		const agentItems = agents.items
			.filter(a => !a.hidden && (a.mode === 'primary' || a.mode === undefined))
			.map(a => ({
				id: a.id,
				label: getAgentLabel(a.id),
				icon: getAgentIcon(a.id, 14),
				description: a.description,
				data: { id: a.id },
			}));

		if (agentItems.length === 0) {
			return [
				{
					id: 'build',
					label: 'Build',
					icon: getAgentIcon('build', 14),
					description: 'Default agent with full tool access',
					data: { id: 'build' },
				},
				{
					id: 'plan',
					label: 'Plan',
					icon: getAgentIcon('plan', 14),
					description: 'Read-only analysis and planning',
					data: { id: 'plan' },
				},
			];
		}

		return agentItems;
	}, [agents.items]);

	const handleSelect = useCallback(
		(agent: AgentData) => {
			onSelect(agent.id === 'build' ? undefined : agent.id);
		},
		[onSelect],
	);

	return (
		<DropdownMenu
			items={items}
			onSelect={handleSelect}
			onClose={onClose}
			keyHints={{}}
			position="top"
			minWidth={140}
			maxWidth={200}
			anchorElement={anchorElement}
		/>
	);
};
