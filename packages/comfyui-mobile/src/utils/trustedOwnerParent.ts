const TRUSTED_OWNER_PARENT_PORTS = new Set(['8765', '8789']);

function normalizedLocalHostname(hostname: string): string {
  const normalized = hostname.toLowerCase();
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(normalized) ? 'loopback' : normalized;
}

export function isTrustedOwnerParentOrigin(
  origin: string,
  currentLocation: Pick<Location, 'hostname' | 'port'> = window.location,
): boolean {
  try {
    const parent = new URL(origin);
    return normalizedLocalHostname(parent.hostname) === normalizedLocalHostname(currentLocation.hostname)
      && (TRUSTED_OWNER_PARENT_PORTS.has(parent.port) || parent.port === currentLocation.port);
  } catch {
    return false;
  }
}

export function isTrustedOwnerParentEvent(event: MessageEvent): boolean {
  return event.source === window.parent && isTrustedOwnerParentOrigin(event.origin);
}
