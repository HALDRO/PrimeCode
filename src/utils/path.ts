/**
 * @file Path Utilities
 * @description Normalizes workspace-relative and OS-specific file paths for safe cross-boundary
 *              communication between extension and webview. Ensures consistent POSIX-style paths
 *              in UI/state, while preserving absolute-path detection for VS Code filesystem APIs.
 */

export function normalizeToPosixPath(input: string): string {
	return input.replace(/\\/g, '/');
}

export function isAbsolutePath(filePath: string): boolean {
	// Windows drive path: C:\...
	if (/^[a-zA-Z]:\\/.test(filePath) || /^[a-zA-Z]:\//.test(filePath)) return true;
	// POSIX absolute path
	return filePath.startsWith('/');
}
