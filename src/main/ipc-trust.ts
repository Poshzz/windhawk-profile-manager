export function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/**
 * The renderer must be either the packaged file document or the exact dev
 * origin. The IPC frame must be the main frame, and its URL must match the
 * window URL; this prevents a remote page from receiving the preload bridge.
 */
export function isTrustedRendererFrame(
  frameUrl: string,
  currentUrl: string,
  packaged: boolean,
  developmentUrl: string | undefined,
): boolean {
  if (!packaged && developmentUrl !== undefined && developmentUrl.length > 0) {
    return sameOrigin(frameUrl, developmentUrl) && sameOrigin(currentUrl, developmentUrl);
  }
  return currentUrl.startsWith('file://') && frameUrl === currentUrl;
}

export function isAllowedExternalUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    (parsed.hostname === 'windhawk.net' || parsed.hostname === 'www.windhawk.net')
  );
}
