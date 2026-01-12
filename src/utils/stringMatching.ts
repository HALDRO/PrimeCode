/**
 * @file stringMatching - Advanced string matching utilities
 * @description Provides fuzzy matching, similarity calculation, and flexible string replacement.
 * Implements multiple matching strategies: exact, whitespace-flexible, fuzzy regex, and
 * Levenshtein-based similarity matching. Used for robust edit operations when exact matches fail.
 * Inspired by VS Code Copilot Chat's editFileToolUtils implementation.
 */

/**
 * Match result types for different matching strategies
 */
export type MatchType = 'exact' | 'whitespace' | 'fuzzy' | 'similarity' | 'multiple' | 'none';

export interface MatchResult {
	type: MatchType;
	text: string;
	editPositions: Array<{ start: number; end: number; text: string }>;
	suggestion?: string;
	similarity?: number;
	matchCount?: number;
}

/**
 * Escapes special regex characters in a string
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Calculates Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
	if (str1 === str2) return 0;
	if (str1.length === 0) return str2.length;
	if (str2.length === 0) return str1.length;

	const matrix: number[][] = [];

	for (let i = 0; i <= str1.length; i++) {
		matrix[i] = [i];
	}
	for (let j = 0; j <= str2.length; j++) {
		matrix[0][j] = j;
	}

	for (let i = 1; i <= str1.length; i++) {
		for (let j = 1; j <= str2.length; j++) {
			const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(
				matrix[i - 1][j] + 1, // deletion
				matrix[i][j - 1] + 1, // insertion
				matrix[i - 1][j - 1] + cost, // substitution
			);
		}
	}

	return matrix[str1.length][str2.length];
}

/**
 * Calculates similarity ratio between two strings (0 to 1)
 */
export function calculateSimilarity(str1: string, str2: string): number {
	if (str1 === str2) return 1.0;
	if (str1.length === 0 || str2.length === 0) return 0.0;

	const distance = levenshteinDistance(str1, str2);
	const maxLength = Math.max(str1.length, str2.length);
	return 1 - distance / maxLength;
}

/**
 * Gets identical leading and trailing characters between two strings
 */
function getIdenticalChars(
	oldString: string,
	newString: string,
): { leading: number; trailing: number } {
	let leading = 0;
	let trailing = 0;

	while (
		leading < oldString.length &&
		leading < newString.length &&
		oldString[leading] === newString[leading]
	) {
		leading++;
	}
	while (
		trailing + leading < oldString.length &&
		trailing + leading < newString.length &&
		oldString[oldString.length - trailing - 1] === newString[newString.length - trailing - 1]
	) {
		trailing++;
	}
	return { leading, trailing };
}

/**
 * Gets identical leading and trailing lines between two arrays
 */
function getIdenticalLines(a: string[], b: string[]): { leading: number; trailing: number } {
	let leading = 0;
	let trailing = 0;

	while (leading < a.length && leading < b.length && a[leading] === b[leading]) {
		leading++;
	}
	while (
		trailing + leading < a.length &&
		trailing + leading < b.length &&
		a[a.length - 1 - trailing] === b[b.length - 1 - trailing]
	) {
		trailing++;
	}

	return { leading, trailing };
}

/**
 * Strategy 1: Try exact match (fastest)
 */
function tryExactMatch(text: string, oldStr: string, newStr: string): MatchResult {
	const matchPositions: number[] = [];
	for (let searchIdx = 0; ; ) {
		const idx = text.indexOf(oldStr, searchIdx);
		if (idx === -1) break;
		matchPositions.push(idx);
		searchIdx = idx + oldStr.length;
	}

	if (matchPositions.length === 0) {
		return { text, editPositions: [], type: 'none' };
	}

	const identical = getIdenticalChars(oldStr, newStr);
	const editPositions = matchPositions.map(idx => ({
		start: idx + identical.leading,
		end: idx + oldStr.length - identical.trailing,
		text: newStr.slice(identical.leading, newStr.length - identical.trailing),
	}));

	if (matchPositions.length > 1) {
		return {
			text,
			type: 'multiple',
			editPositions,
			matchCount: matchPositions.length,
			suggestion: 'Multiple exact matches found. Make your search string more specific.',
		};
	}

	const firstIdx = matchPositions[0];
	const replaced = text.slice(0, firstIdx) + newStr + text.slice(firstIdx + oldStr.length);
	return {
		text: replaced,
		type: 'exact',
		editPositions,
	};
}

/**
 * Strategy 2: Try whitespace-flexible matching
 */
function tryWhitespaceFlexibleMatch(
	text: string,
	oldStr: string,
	newStr: string,
	eol: string,
): MatchResult {
	const haystack = text.split(eol).map(line => line.trim());
	const oldLines = oldStr.trim().split(eol);
	const needle = oldLines.map(line => line.trim());
	needle.push(''); // trailing newline to match until end of line

	const matchedLines: number[] = [];
	for (let i = 0; i <= haystack.length - needle.length; i++) {
		if (haystack.slice(i, i + needle.length).join('\n') === needle.join('\n')) {
			matchedLines.push(i);
			i += needle.length - 1;
		}
	}

	if (matchedLines.length === 0) {
		return {
			text,
			editPositions: [],
			type: 'none',
			suggestion: 'No whitespace-flexible match found.',
		};
	}

	if (matchedLines.length > 1) {
		return {
			text,
			type: 'multiple',
			editPositions: [],
			matchCount: matchedLines.length,
			suggestion:
				'Multiple matches found with flexible whitespace. Make your search string more unique.',
		};
	}

	// Calculate position for single match
	const lines = text.split(eol);
	const matchLine = matchedLines[0];
	const newLines = newStr.trim().split(eol);
	const identical = getIdenticalLines(oldLines, newLines);

	let startIdx = 0;
	for (let i = 0; i < matchLine + identical.leading; i++) {
		startIdx += lines[i].length + eol.length;
	}

	let endIdx = startIdx;
	for (
		let i = matchLine + identical.leading;
		i < matchLine + oldLines.length - identical.trailing;
		i++
	) {
		endIdx += lines[i].length + eol.length;
	}
	endIdx -= eol.length; // Remove last EOL

	const minimizedNewStr = newLines
		.slice(identical.leading, newLines.length - identical.trailing)
		.join(eol);
	const replaced = text.slice(0, startIdx) + minimizedNewStr + text.slice(endIdx);

	return {
		text: replaced,
		editPositions: [{ start: startIdx, end: endIdx, text: minimizedNewStr }],
		type: 'whitespace',
	};
}

/**
 * Strategy 3: Try fuzzy matching with regex
 */
function tryFuzzyMatch(text: string, oldStr: string, newStr: string, eol: string): MatchResult {
	const hasTrailingLF = oldStr.endsWith(eol);
	if (hasTrailingLF) {
		oldStr = oldStr.slice(0, -eol.length);
	}

	const oldLines = oldStr.split(eol);
	const pattern = oldLines
		.map((line, i) => {
			const escaped = escapeRegex(line);
			return i < oldLines.length - 1 || hasTrailingLF
				? `${escaped}[ \\t]*\\r?\\n`
				: `${escaped}[ \\t]*`;
		})
		.join('');

	const regex = new RegExp(pattern, 'g');
	const matches = Array.from(text.matchAll(regex));

	if (matches.length === 0) {
		return {
			text,
			editPositions: [],
			type: 'none',
			suggestion: 'No fuzzy match found.',
		};
	}

	if (matches.length > 1) {
		return {
			text,
			type: 'multiple',
			editPositions: [],
			matchCount: matches.length,
			suggestion: 'Multiple fuzzy matches found. Try including more context in your search string.',
		};
	}

	const match = matches[0];
	const startIdx = match.index || 0;
	const endIdx = startIdx + match[0].length;
	const replaced = text.slice(0, startIdx) + newStr + text.slice(endIdx);

	return {
		text: replaced,
		type: 'fuzzy',
		editPositions: [{ start: startIdx, end: endIdx, text: newStr }],
	};
}

/**
 * Strategy 4: Try similarity-based matching (last resort)
 */
function trySimilarityMatch(
	text: string,
	oldStr: string,
	newStr: string,
	eol: string,
	threshold: number = 0.85,
): MatchResult {
	// Skip for very large strings
	if (oldStr.length > 1000 || oldStr.split(eol).length > 30) {
		return { text, editPositions: [], type: 'none' };
	}

	const lines = text.split(eol);
	const oldLines = oldStr.split(eol);

	// Skip for very large files
	if (lines.length > 2000) {
		return { text, editPositions: [], type: 'none' };
	}

	const newLines = newStr.split(eol);
	const identical = getIdenticalLines(oldLines, newLines);

	let bestMatch = { startLine: -1, startOffset: 0, oldLength: 0, similarity: 0 };
	let startOffset = 0;

	// Sliding window to find best matching section
	for (let i = 0; i <= lines.length - oldLines.length; i++) {
		let totalSimilarity = 0;
		let oldLength = 0;

		let startOffsetIdenticalIncr = 0;
		let endOffsetIdenticalIncr = 0;

		for (let j = 0; j < oldLines.length; j++) {
			const similarity = calculateSimilarity(oldLines[j], lines[i + j]);
			totalSimilarity += similarity;
			oldLength += lines[i + j].length;

			if (j < identical.leading) {
				startOffsetIdenticalIncr += lines[i + j].length + eol.length;
			}
			if (j >= oldLines.length - identical.trailing) {
				endOffsetIdenticalIncr += lines[i + j].length + eol.length;
			}
		}

		const avgSimilarity = totalSimilarity / oldLines.length;
		if (avgSimilarity > threshold && avgSimilarity > bestMatch.similarity) {
			bestMatch = {
				startLine: i + identical.leading,
				startOffset: startOffset + startOffsetIdenticalIncr,
				similarity: avgSimilarity,
				oldLength:
					oldLength +
					(oldLines.length - 1) * eol.length -
					startOffsetIdenticalIncr -
					endOffsetIdenticalIncr,
			};
		}

		startOffset += lines[i].length + eol.length;
	}

	if (bestMatch.startLine === -1) {
		return { text, editPositions: [], type: 'none' };
	}

	const newStrMinimized = newLines
		.slice(identical.leading, newLines.length - identical.trailing)
		.join(eol);
	const matchStart = bestMatch.startLine - identical.leading;
	const afterIdx = matchStart + oldLines.length - identical.trailing;

	const newText = [
		...lines.slice(0, bestMatch.startLine),
		...newLines.slice(identical.leading, newLines.length - identical.trailing),
		...lines.slice(afterIdx),
	].join(eol);

	return {
		text: newText,
		type: 'similarity',
		editPositions: [
			{
				start: bestMatch.startOffset,
				end: bestMatch.startOffset + bestMatch.oldLength,
				text: newStrMinimized,
			},
		],
		similarity: bestMatch.similarity,
		suggestion: `Used similarity matching (${(bestMatch.similarity * 100).toFixed(1)}% similar). Verify the replacement.`,
	};
}

/**
 * Main function: Find and replace with multiple strategies
 * Tries strategies in order: exact -> whitespace -> fuzzy -> similarity
 */
export function findAndReplace(
	text: string,
	oldStr: string,
	newStr: string,
	eol: string = '\n',
): MatchResult {
	// Strategy 1: Exact match
	const exactResult = tryExactMatch(text, oldStr, newStr);
	if (exactResult.type !== 'none') {
		return exactResult;
	}

	// Strategy 2: Whitespace-flexible
	const whitespaceResult = tryWhitespaceFlexibleMatch(text, oldStr, newStr, eol);
	if (whitespaceResult.type !== 'none') {
		return whitespaceResult;
	}

	// Strategy 3: Fuzzy regex
	const fuzzyResult = tryFuzzyMatch(text, oldStr, newStr, eol);
	if (fuzzyResult.type !== 'none') {
		return fuzzyResult;
	}

	// Strategy 4: Similarity-based
	const similarityResult = trySimilarityMatch(text, oldStr, newStr, eol);
	if (similarityResult.type !== 'none') {
		return similarityResult;
	}

	return {
		text,
		type: 'none',
		editPositions: [],
		suggestion:
			'No match found. Try making your search string more specific or check for whitespace/formatting differences.',
	};
}

/**
 * Check if two strings are similar enough (above threshold)
 */
export function isSimilar(str1: string, str2: string, threshold: number = 0.8): boolean {
	return calculateSimilarity(str1, str2) >= threshold;
}

/**
 * Find the best matching substring in text for a given pattern
 */
export function findBestMatch(
	text: string,
	pattern: string,
	threshold: number = 0.7,
): { match: string; similarity: number; index: number } | null {
	if (!pattern || !text) return null;

	const patternLen = pattern.length;
	let bestMatch = { match: '', similarity: 0, index: -1 };

	// Sliding window search
	for (let i = 0; i <= text.length - patternLen; i++) {
		const candidate = text.slice(i, i + patternLen);
		const similarity = calculateSimilarity(pattern, candidate);

		if (similarity > bestMatch.similarity) {
			bestMatch = { match: candidate, similarity, index: i };
		}
	}

	// Also try with some length variance
	for (let lenDiff = -5; lenDiff <= 5; lenDiff++) {
		if (lenDiff === 0) continue;
		const candidateLen = patternLen + lenDiff;
		if (candidateLen <= 0) continue;

		for (let i = 0; i <= text.length - candidateLen; i++) {
			const candidate = text.slice(i, i + candidateLen);
			const similarity = calculateSimilarity(pattern, candidate);

			if (similarity > bestMatch.similarity) {
				bestMatch = { match: candidate, similarity, index: i };
			}
		}
	}

	return bestMatch.similarity >= threshold ? bestMatch : null;
}
