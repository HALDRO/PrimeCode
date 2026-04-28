export async function copyTextToClipboard(text: string): Promise<boolean> {
	if (!text) return false;

	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Fall through to the textarea-based path for restricted webview contexts.
	}

	const textarea = document.createElement('textarea');
	textarea.value = text;
	textarea.setAttribute('readonly', '');
	textarea.style.position = 'fixed';
	textarea.style.top = '0';
	textarea.style.left = '-9999px';
	document.body.appendChild(textarea);
	textarea.select();

	try {
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		textarea.remove();
	}
}
