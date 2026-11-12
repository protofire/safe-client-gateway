import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { Clock, type IClock } from '@/modules/org/common/clock';

const TIMEOUT_MS = 10_000;
const GOOGLE_ISSUER = 'https://accounts.google.com';

/**
 * `iss` values accepted for the configured issuer. Google issues both
 * `https://accounts.google.com` and `accounts.google.com`; identities are
 * always stored under the configured (canonical) issuer.
 */
export function acceptedIssuers(issuer: string): Array<string> {
  return issuer === GOOGLE_ISSUER ? [issuer, 'accounts.google.com'] : [issuer];
}

type Discovery = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
};

/**
 * Google as the OIDC issuer: authorization code + PKCE S256, endpoints from
 * the issuer's discovery document, ID token verified against its JWKS. Any
 * failure throws; the caller maps it to an error redirect.
 */
@Injectable()
export class OidcClient {
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private discovery: Promise<Discovery> | undefined;

  constructor(
    @Inject(IConfigurationService) config: IConfigurationService,
    @Inject(Clock) private readonly clock: IClock,
  ) {
    this.issuer = config.getOrThrow<string>('org.oidc.issuer');
    this.clientId = config.getOrThrow<string>('org.oidc.clientId');
    this.clientSecret = config.getOrThrow<string>('org.oidc.clientSecret');
    this.redirectUri = config.getOrThrow<string>('org.oidc.redirectUri');
  }

  /** The canonical issuer string stored on identities. */
  get issuerId(): string {
    return this.issuer;
  }

  async authorizeUrl(args: {
    state: string;
    nonce: string;
    codeChallenge: string;
    /** `select_account`: the user picks the account, the IdP session is not reused silently. */
    prompt?: 'select_account';
  }): Promise<string> {
    const url = new URL((await this.discover()).authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: 'openid email profile',
      state: args.state,
      nonce: args.nonce,
      code_challenge: args.codeChallenge,
      code_challenge_method: 'S256',
      ...(args.prompt ? { prompt: args.prompt } : {}),
    }).toString();
    return url.toString();
  }

  /**
   * Code → verified identity. Requires `email_verified === true`.
   * `authTime`: the `auth_time` claim (seconds), when a number.
   */
  async signIn(
    code: string,
    verifier: string,
    nonce: string,
  ): Promise<{ subject: string; email: string; authTime?: number }> {
    const { tokenEndpoint, jwks } = await this.discover();
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: this.redirectUri,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
    const { id_token: idToken } = (await res.json()) as { id_token?: unknown };
    if (typeof idToken !== 'string') throw new Error('no id_token');

    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: acceptedIssuers(this.issuer),
      audience: this.clientId,
      algorithms: ['RS256', 'ES256'],
      currentDate: this.clock.now(),
      requiredClaims: ['sub', 'exp', 'nonce'],
    });
    if (
      payload.nonce !== nonce ||
      payload.email_verified !== true ||
      typeof payload.email !== 'string' ||
      payload.email === '' ||
      typeof payload.sub !== 'string' ||
      payload.sub === ''
    ) {
      throw new Error('ID token claims rejected');
    }
    return {
      subject: payload.sub,
      email: payload.email,
      ...(typeof payload.auth_time === 'number'
        ? { authTime: payload.auth_time }
        : {}),
    };
  }

  /** Discovery document, fetched once per process; a failed fetch is retried on the next call. */
  private discover(): Promise<Discovery> {
    this.discovery ??= this.fetchDiscovery().catch((error: unknown) => {
      this.discovery = undefined;
      throw error;
    });
    return this.discovery;
  }

  private async fetchDiscovery(): Promise<Discovery> {
    const url = `${this.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`discovery answered ${res.status}`);
    const doc = (await res.json()) as Record<string, unknown>;
    if (doc.issuer !== this.issuer) {
      throw new Error('discovery issuer does not match ORG_OIDC_ISSUER');
    }
    const endpoint = (name: string): string => {
      const value = doc[name];
      if (typeof value !== 'string' || !URL.canParse(value)) {
        throw new Error(`discovery has no valid ${name}`);
      }
      return value;
    };
    return {
      authorizationEndpoint: endpoint('authorization_endpoint'),
      tokenEndpoint: endpoint('token_endpoint'),
      jwks: createRemoteJWKSet(new URL(endpoint('jwks_uri'))),
    };
  }
}
