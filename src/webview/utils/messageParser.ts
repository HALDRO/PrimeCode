/**
 * @file messageParser.ts
 * @description Shared logic for parsing message text to identify commands and subagents.
 *              Used by both ChatInput (for syntax highlighting) and UserMessage (for display).
 */

export interface MessageHighlight {
	start: number;
	end: number;
	content: string;
	type: 'command' | 'subagent';
}

export interface TextSegment {
	content: string;
	type: 'text' | 'command' | 'subagent';
}

/**
 * Finds all commands (starting with /) and subagents (starting with @) in the text.
 * Returns a list of highlights sorted by position.
 */
export function getMessageHighlights(
	text: string,
	validCommands: Set<string>,
	validSubagents: Set<string>,
): MessageHighlight[] {
	const highlights: MessageHighlight[] = [];

	// 1. Find slash commands
	const cmdRegex = /\/([a-zA-Z][a-zA-Z0-9_-]*)/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec pattern
	while ((match = cmdRegex.exec(text)) !== null) {
		const commandName = match[1].toLowerCase();
		if (validCommands.has(commandName)) {
			highlights.push({
				start: match.index,
				end: match.index + match[0].length,
				content: match[0],
				type: 'command',
			});
		}
	}

	// 2. Find subagents (@name)
	const agentRegex = /@([a-zA-Z0-9_-]+)/g;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec pattern
	while ((match = agentRegex.exec(text)) !== null) {
		const agentName = match[1].toLowerCase();
		if (validSubagents.has(agentName)) {
			highlights.push({
				start: match.index,
				end: match.index + match[0].length,
				content: match[0],
				type: 'subagent',
			});
		}
	}

	// Sort by start position
	return highlights.sort((a, b) => a.start - b.start);
}

/**
 * Parses text into a sequence of segments (text, command, subagent) for rendering.
 */
export function parseMessageSegments(
	text: string,
	validCommands: Set<string>,
	validSubagents: Set<string>,
): TextSegment[] {
	const highlights = getMessageHighlights(text, validCommands, validSubagents);
	const segments: TextSegment[] = [];
	let lastIndex = 0;

	for (const highlight of highlights) {
		// Add text before the highlight
		if (highlight.start > lastIndex) {
			segments.push({
				content: text.substring(lastIndex, highlight.start),
				type: 'text',
			});
		}

		// Add the highlight itself
		segments.push({
			content: highlight.content,
			type: highlight.type,
		});

		lastIndex = highlight.end;
	}

	// Add remaining text
	if (lastIndex < text.length) {
		segments.push({
			content: text.substring(lastIndex),
			type: 'text',
		});
	}

	return segments;
}
