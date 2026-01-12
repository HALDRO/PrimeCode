/**
 * @file Format utilities - centralized formatting functions for the webview
 * @description Provides consistent formatting for numbers, tokens, durations, costs,
 * relative time, and tool names across all webview components.
 */

/**
 * Format duration in milliseconds to human-readable string
 */
export const formatDuration = (ms: number): string => {
	const totalSeconds = ms / 1000;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m ${seconds.toFixed(2)}s`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds.toFixed(2)}s`;
	}
	return `${seconds.toFixed(2)}s`;
};

/**
 * Format timestamp to time string (HH:MM)
 */
export const formatTime = (timestamp: string | number): string => {
	const date = typeof timestamp === 'string' ? new Date(timestamp) : new Date(timestamp);
	return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
};

/**
 * Format timestamp to relative time string (e.g. "5m ago", "yesterday", "Jan 15")
 */
export const formatRelativeTime = (dateInput: string | number | Date): string => {
	if (!dateInput) {
		return '';
	}

	try {
		const date = new Date(dateInput);
		const now = new Date();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

		// Future dates or invalid dates check could be added here if needed

		// Today: show relative time
		if (date >= today) {
			const diffMs = now.getTime() - date.getTime();
			const diffMins = Math.floor(diffMs / (1000 * 60));

			if (diffMins < 1) {
				return 'now';
			}
			if (diffMins < 60) {
				return `${diffMins}m ago`;
			}

			const diffHours = Math.floor(diffMins / 60);
			return `${diffHours}h ago`;
		}

		// Yesterday
		const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
		if (date >= yesterday) {
			return 'yesterday';
		}

		// Older: show date
		return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
	} catch {
		return '';
	}
};

/**
 * Format large numbers with K/M suffixes
 */
export const formatNumber = (num: number): string => {
	if (num >= 1_000_000) {
		return `${(num / 1_000_000).toFixed(1)}M`;
	}
	if (num >= 1_000) {
		return `${(num / 1_000).toFixed(1)}K`;
	}
	return num.toString();
};

/**
 * Format token count with appropriate suffix
 */
export const formatTokens = (tokens: number): string => formatNumber(tokens);

/**
 * Format tool name for display
 */
export const formatToolName = (name: string): string => {
	if (name.startsWith('mcp__') || name.startsWith('mcp_')) {
		const parts = name.replace(/^mcp_+/, '').split('_');
		return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
	}
	return name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
};

/**
 * Format cost in dollars
 */
export const formatCost = (cost: number): string => {
	if (!cost || cost === 0) {
		return '$0.00';
	}
	if (cost < 0.01) {
		return `$${cost.toFixed(4)}`;
	}
	return `$${cost.toFixed(2)}`;
};

/**
 * Extract file name from full path (cross-platform)
 */
export const getShortFileName = (filePath: string): string => {
	const parts = filePath.replace(/\\/g, '/').split('/');
	return parts[parts.length - 1] || filePath;
};
