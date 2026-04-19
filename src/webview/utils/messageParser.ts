/**
 * @file messageParser.ts
 * @description Shared logic for parsing message text to identify commands and subagents.
 *              Used by both ChatInput (for syntax highlighting) and UserMessage (for display).
 */

interface MessageHighlight {
	start: number;
	end: number;
	content: string;
	type: 'command' | 'subagent';
}

interface TextSegment {
	start: number;
	end: number;
	content: string;
	type: 'text' | 'command' | 'subagent';
}

const isBoundaryChar = (char: string | undefined): boolean => !char || /\s/.test(char);

const collectTokenHighlights = (
	text: string,
	prefix: '/' | '@',
	validNames: Set<string>,
	type: MessageHighlight['type'],
): MessageHighlight[] => {
	const highlights: MessageHighlight[] = [];
	const regex = new RegExp(`\\${prefix}([a-zA-Z][a-zA-Z0-9_-]*)`, 'g');
	let match: RegExpExecArray | null;

	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec pattern
	while ((match = regex.exec(text)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		const name = match[1].toLowerCase();
		const prevChar = text[start - 1];
		const nextChar = text[end];

		if (!isBoundaryChar(prevChar) || !isBoundaryChar(nextChar) || !validNames.has(name)) {
			continue;
		}

		highlights.push({
			start,
			end,
			content: match[0],
			type,
		});
	}

	return highlights;
};

/**
 * Finds all commands (starting with /) and subagents (starting with @) in the text.
 * Returns a list of highlights sorted by position.
 */
export function getMessageHighlights(
	text: string,
	validCommands: Set<string>,
	validSubagents: Set<string>,
): MessageHighlight[] {
	const highlights = [
		...collectTokenHighlights(text, '/', validCommands, 'command'),
		...collectTokenHighlights(text, '@', validSubagents, 'subagent'),
	];

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
				start: lastIndex,
				end: highlight.start,
				content: text.substring(lastIndex, highlight.start),
				type: 'text',
			});
		}

		// Add the highlight itself
		segments.push({
			start: highlight.start,
			end: highlight.end,
			content: highlight.content,
			type: highlight.type,
		});

		lastIndex = highlight.end;
	}

	// Add remaining text
	if (lastIndex < text.length) {
		segments.push({
			start: lastIndex,
			end: text.length,
			content: text.substring(lastIndex),
			type: 'text',
		});
	}

	return segments;
}
