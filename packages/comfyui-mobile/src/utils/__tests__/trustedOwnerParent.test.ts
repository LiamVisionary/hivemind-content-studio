import { describe, expect, it } from 'vitest';
import { isTrustedOwnerParentOrigin } from '../trustedOwnerParent';

describe('trusted owner parent origins', () => {
  it('accepts loopback host aliases between Studio and embedded tool surfaces', () => {
    expect(isTrustedOwnerParentOrigin('http://localhost:8765', {
      hostname: '127.0.0.1',
      port: '8788',
    })).toBe(true);
    expect(isTrustedOwnerParentOrigin('http://127.0.0.1:8765', {
      hostname: 'localhost',
      port: '8788',
    })).toBe(true);
  });

  it('accepts the tailscale HTTPS proxy and rejects unrelated origins', () => {
    expect(isTrustedOwnerParentOrigin('https://studio.tailnet.example:8789', {
      hostname: 'studio.tailnet.example',
      port: '8789',
    })).toBe(true);
    expect(isTrustedOwnerParentOrigin('http://evil.example:8765', {
      hostname: '127.0.0.1',
      port: '8788',
    })).toBe(false);
    expect(isTrustedOwnerParentOrigin('http://127.0.0.1:9999', {
      hostname: '127.0.0.1',
      port: '8788',
    })).toBe(false);
  });
});
