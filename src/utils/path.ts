/**
 * @file Path Utilities
 * @description Shared string-level path helpers used across extension/common/webview.
 * Keep these helpers generic: slash normalization, file URI decoding, basename extraction,
 * workspace-relative joining, and cross-platform comparable path matching.
 */

/**
 * Uppercase the Windows drive letter for consistent path comparison.
 * VS Code `uri.fsPath` returns lowercase (`c:\...`), but OpenCode server
 * stores paths with uppercase (`C:\...`) via `realpathSync.native`.
 * The server filters sessions by exact string match on `directory`.
 */
export function normalizeDriveLetter(dir: string): string {
	return dir.length >= 2 && dir[1] === ':' ? dir[0].toUpperCase() + dir.slice(1) : dir;
}

export function normalizeToPosixPath(input: string): string {
	return input.replace(/\\/g, '/');
}

export function normalizeComparablePath(input: string): string {
	return normalizeToPosixPath(input).replace(/^[A-Z]:/, drive => drive.toLowerCase());
}

export function trimLeadingSlashes(input: string): string {
	return input.replace(/^[\\/]+/, '');
}

export function trimTrailingSlashes(input: string): string {
	return input.replace(/[\\/]+$/, '');
}

export function joinPathSegments(base: string, next: string): string {
	if (!base) return normalizeToPosixPath(next);
	if (!next) return normalizeToPosixPath(base);
	return `${trimTrailingSlashes(normalizeToPosixPath(base))}/${trimLeadingSlashes(normalizeToPosixPath(next))}`;
}

export function getPathBaseName(filePath: string): string {
	const normalized = normalizeToPosixPath(filePath);
	const parts = normalized.split('/');
	return parts[parts.length - 1] || filePath;
}

export function decodeFilePath(raw: string): string {
	let value = raw.trim();
	if (value.startsWith('file:///')) {
		value = value.substring(8);
		if (!/^[a-zA-Z]:/.test(value)) value = `/${value}`;
	} else if (value.startsWith('file://')) {
		value = value.substring(7);
	}

	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export function toFileUri(filePath: string): string {
	if (filePath.startsWith('file://')) return filePath;
	return `file://${normalizeToPosixPath(filePath)}`;
}

export function pathsReferToSameFile(left: string, right: string, workspaceRoot?: string): boolean {
	const normalizedLeft = normalizeComparablePath(left);
	const normalizedRight = normalizeComparablePath(right);
	if (normalizedLeft === normalizedRight) return true;

	const workspaceJoinedRight = workspaceRoot
		? normalizeComparablePath(joinPathSegments(workspaceRoot, right))
		: '';
	if (workspaceJoinedRight && normalizedLeft === workspaceJoinedRight) return true;

	return normalizedLeft.endsWith(`/${normalizedRight}`);
}
