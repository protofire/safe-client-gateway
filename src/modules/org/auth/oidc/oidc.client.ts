import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { Clock, type IClock } from '@/modules/org/common/clock';

export type OidcConnection = 'email' | 'google-oauth2';

const TOKEN_TIMEOUT_MS = 10_000;

/**
 * Auth0 as the OIDC issuer: authorization code + PKCE S256, ID token verified
 * against the issuer's JWKS. Any failure throws; the caller maps it to 401.
 */
@Injectable()
export class OidcClient {
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    @Inject(IConfigurationService) config: IConfigurationService,
    @Inject(Clock) private readonly clock: IClock,
  ) {
    this.issuer = config.getOrThrow<string>('org.oidc.issuer');
    this.clientId = config.getOrThrow<string>('org.oidc.clientId');
    this.clientSecret = config.getOrThrow<string>('org.oidc.clientSecret');
    this.redirectUri = config.getOrThrow<string>('org.oidc.redirectUri');
    this.jwks = createRemoteJWKSet(
      new URL('.well-known/jwks.json', this.issuer),
    );
  }

  get issuerId(): string {
    return this.issuer;
  }

  authorizeUrl(args: {
    state: string;
    nonce: string;
    codeChallenge: string;
    connection: OidcConnection;
    /** `login`: the IdP must re-authenticate, not reuse its own session. */
    prompt?: 'login';
  }): string {
    const url = new URL('authorize', this.issuer);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: 'openid email profile',
      state: args.state,
      nonce: args.nonce,
      code_challenge: args.codeChallenge,
      code_challenge_method: 'S256',
      connection: args.connection,
      ...(args.prompt ? { prompt: args.prompt } : {}),
    }).toString();
    return url.toString();
  }

  /** Code → verified identity. Requires `email_verified === true`. */
  async signIn(
    code: string,
    verifier: string,
    nonce: string,
  ): Promise<{ subject: string; email: string }> {
    const res = await fetch(new URL('oauth/token', this.issuer), {
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
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
    const { id_token: idToken } = (await res.json()) as { id_token?: unknown };
    if (typeof idToken !== 'string') throw new Error('no id_token');

    const { payload } = await jwtVerify(idToken, this.jwks, {
      issuer: this.issuer,
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
      typeof payload.sub !== 'string'
    ) {
      throw new Error('ID token claims rejected');
    }
    return { subject: payload.sub, email: payload.email };
  }
}
