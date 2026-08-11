import { describe, expect, it, vi } from 'vitest';
import { signWebhookBody } from '@/server/crypto';
import {
  GATEWAY_PROVIDERS,
  GatewayNotActivatedError,
  UnknownGatewayProviderError,
  adapterFor,
  adapterForValue,
  gatewayReadiness,
  instructionsFrom,
  isActivated,
  isGatewayProvider,
  listAdapters,
  type GatewayState,
} from '@/server/payments';

/**
 * The gateway layer, with no database and no network.
 *
 * The properties worth freezing before there is money behind any of this:
 *   - exactly ONE provider can take money today, and the other three refuse LOUDLY rather than
 *     returning something a caller might treat as success;
 *   - the callback signature is checked over the RAW BYTES and in constant time;
 *   - no adapter ever returns a credential.
 */

const SECRET = 'a-shared-secret-that-is-long-enough';

function signed(body: string, header: string): { body: string; headers: Headers } {
  return { body, headers: new Headers({ [header]: signWebhookBody(SECRET, body) }) };
}

const SETTLEMENT = JSON.stringify({
  orderId: 'ord_123',
  reference: 'REF-9',
  amountAgorot: 12_500,
  status: 'paid',
});

describe('the provider registry', () => {
  it('has an adapter for every provider in the enum', () => {
    for (const provider of GATEWAY_PROVIDERS) {
      expect(adapterFor(provider).provider).toBe(provider);
    }
    expect(listAdapters()).toHaveLength(GATEWAY_PROVIDERS.length);
  });

  it('activates exactly one provider — manual — and scaffolds the rest (the Launch Gate)', () => {
    expect(isActivated('manual')).toBe(true);
    for (const provider of ['meshulam', 'tranzila', 'paypal'] as const) {
      expect(isActivated(provider), provider).toBe(false);
      expect(adapterFor(provider).status).toBe('scaffolded');
    }
  });

  it('throws on an unknown provider string rather than falling back to a default', () => {
    expect(isGatewayProvider('stripe')).toBe(false);
    expect(() => adapterForValue('stripe')).toThrow(UnknownGatewayProviderError);
  });
});

describe('the manual adapter — cash and bank transfer', () => {
  it('returns "nothing to redirect to" and makes no network call', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('the manual adapter must never reach the network');
    });
    vi.stubGlobal('fetch', fetchSpy);

    try {
      const link = await adapterFor('manual').createPaymentLink(
        {
          tenantId: 't1',
          orderId: 'o1',
          orderNumber: 1,
          amountAgorot: 5_000,
          currency: 'ILS',
          returnUrl: 'https://shop.test/thanks',
          callbackUrl: 'https://shop.test/api/storefront/gateway/manual',
        },
        {},
      );

      expect(link).toEqual({ kind: 'none' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses every callback — there is no webhook for cash', async () => {
    const result = await adapterFor('manual').verifyCallback(signed(SETTLEMENT, 'x-any'), {});
    expect(result).toEqual({ ok: false, reason: 'not_activated' });
  });

  it('needs no credentials at all', () => {
    expect(adapterFor('manual').credentialFields).toEqual([]);
  });
});

describe('the scaffolded adapters', () => {
  const cases = [
    { provider: 'meshulam', header: 'x-meshulam-signature' },
    { provider: 'tranzila', header: 'x-tranzila-signature' },
    { provider: 'paypal', header: 'paypal-transmission-sig' },
  ] as const;

  for (const { provider, header } of cases) {
    it(`${provider} refuses to mint a payment link`, async () => {
      await expect(
        adapterFor(provider).createPaymentLink(
          {
            tenantId: 't1',
            orderId: 'o1',
            orderNumber: 1,
            amountAgorot: 5_000,
            currency: 'ILS',
            returnUrl: 'https://shop.test/thanks',
            callbackUrl: 'https://shop.test/cb',
          },
          { webhookSecret: SECRET },
        ),
      ).rejects.toBeInstanceOf(GatewayNotActivatedError);
    });

    it(`${provider} verifies a correctly signed settlement`, async () => {
      const result = await adapterFor(provider).verifyCallback(signed(SETTLEMENT, header), {
        webhookSecret: SECRET,
      });

      expect(result).toEqual({
        ok: true,
        orderId: 'ord_123',
        providerRef: 'REF-9',
        paidAgorot: 12_500,
        status: 'paid',
      });
    });

    it(`${provider} rejects a body mutated by ONE character`, async () => {
      const original = signed(SETTLEMENT, header);
      const tampered = {
        // The signature is unchanged; the body is not. This is the whole point of signing.
        body: SETTLEMENT.replace('12500', '12501'),
        headers: original.headers,
      };

      expect(await adapterFor(provider).verifyCallback(tampered, { webhookSecret: SECRET })).toEqual(
        { ok: false, reason: 'bad_signature' },
      );
    });

    it(`${provider} rejects a missing signature header`, async () => {
      const result = await adapterFor(provider).verifyCallback(
        { body: SETTLEMENT, headers: new Headers() },
        { webhookSecret: SECRET },
      );
      expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it(`${provider} reports "not activated" when no secret is stored`, async () => {
      const result = await adapterFor(provider).verifyCallback(signed(SETTLEMENT, header), {});
      expect(result).toEqual({ ok: false, reason: 'not_activated' });
    });

    it(`${provider} rejects a correctly signed body that is not a settlement`, async () => {
      const junk = JSON.stringify({ hello: 'world' });
      expect(
        await adapterFor(provider).verifyCallback(signed(junk, header), { webhookSecret: SECRET }),
      ).toEqual({ ok: false, reason: 'malformed' });

      expect(
        await adapterFor(provider).verifyCallback(signed('not json at all', header), {
          webhookSecret: SECRET,
        }),
      ).toEqual({ ok: false, reason: 'malformed' });
    });
  }
});

describe('no adapter ever hands back a credential', () => {
  it('keeps the secret out of every return value', async () => {
    const results: unknown[] = [];

    for (const provider of GATEWAY_PROVIDERS) {
      const adapter = adapterFor(provider);
      results.push(await adapter.verifyCallback(signed(SETTLEMENT, 'x-any'), { webhookSecret: SECRET }));
      if (adapter.status === 'active') {
        results.push(
          await adapter.createPaymentLink(
            {
              tenantId: 't1',
              orderId: 'o1',
              orderNumber: 1,
              amountAgorot: 1,
              currency: 'ILS',
              returnUrl: 'https://a.test',
              callbackUrl: 'https://a.test',
            },
            { webhookSecret: SECRET },
          ),
        );
      }
    }

    expect(JSON.stringify(results)).not.toContain(SECRET);
  });
});

describe('gatewayReadiness — one enum, two surfaces', () => {
  const state = (over: Partial<GatewayState> = {}): GatewayState => ({
    provider: 'manual',
    status: 'active',
    enabled: true,
    hasCredentials: false,
    instructions: null,
    ...over,
  });

  it('answers feature_off first, whatever else is configured', () => {
    expect(gatewayReadiness({ featureOn: false, state: state() })).toBe('feature_off');
    expect(gatewayReadiness({ featureOn: false, state: null })).toBe('feature_off');
  });

  it('answers no_provider when nothing is switched on', () => {
    expect(gatewayReadiness({ featureOn: true, state: null })).toBe('no_provider');
  });

  it('answers not_activated for a scaffolded provider', () => {
    expect(
      gatewayReadiness({
        featureOn: true,
        state: state({ provider: 'meshulam', status: 'scaffolded', hasCredentials: true }),
      }),
    ).toBe('not_activated');
  });

  it('answers no_credentials only for a provider that needs some', () => {
    // `manual` declares no credential fields, so an absent blob is not a gap — it is the design.
    expect(gatewayReadiness({ featureOn: true, state: state({ hasCredentials: false }) })).toBe(
      'ready',
    );
  });

  it('answers ready when everything holds', () => {
    expect(gatewayReadiness({ featureOn: true, state: state({ hasCredentials: true }) })).toBe(
      'ready',
    );
  });
});

describe('instructionsFrom — a Json column with no declared shape', () => {
  it('reads a string and refuses everything else', () => {
    expect(instructionsFrom({ instructions: 'حوّل على الحساب رقم 12345' })).toBe(
      'حوّل على الحساب رقم 12345',
    );
    expect(instructionsFrom({ instructions: '   ' })).toBeNull();
    expect(instructionsFrom({ instructions: { nested: true } })).toBeNull();
    expect(instructionsFrom(null)).toBeNull();
    expect(instructionsFrom('a string')).toBeNull();
  });
});
