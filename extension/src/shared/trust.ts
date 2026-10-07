// Who may talk to the service worker, and which origins may be "remembered". Pure functions so they are unit-tested.

/**
 * Runtime messages (commands, delete, offscreen events) are only accepted from this extension's own pages (side panel, Review,
 * offscreen document). Content scripts run inside web pages and talk over their own validated port; a message that arrives from a
 * page context, another extension or a different sender id is ignored.
 */
export function isOwnExtensionPage(sender: { id?: string; url?: string } | undefined, extensionId: string, baseUrl: string): boolean {
  return !!sender && sender.id === extensionId && typeof sender.url === 'string' && sender.url.startsWith(baseUrl);
}

/** Ports are only accepted from this extension's own content scripts (they always carry a tab). */
export function isOwnContentScript(sender: { id?: string; tab?: { id?: number } } | undefined, extensionId: string): boolean {
  return !!sender && sender.id === extensionId && sender.tab?.id != null;
}

/** "Remember this site" registers a persistent content script, so the origin must be a plain http(s) origin: no wildcard, path, query or credentials. */
export function isRememberableOrigin(origin: unknown): origin is string {
  return typeof origin === 'string' && origin.length <= 253 && /^https?:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:]+\])(?::\d{1,5})?$/i.test(origin);
}
