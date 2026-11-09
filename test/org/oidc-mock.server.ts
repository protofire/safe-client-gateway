/**
 * Local stand-in for Auth0 (authorization code + PKCE): `/authorize` approves
 * at once and redirects back with a code, `/oauth/token` returns an ES256 ID
 * token signed with an in-memory key, `/.well-known/jwks.json` serves the
 * public key. For tests and local dev (`yarn start:org-oidc-mock`, then
 * ORG_OIDC_ISSUER=http://127.0.0.1:4010/). Never deploy it.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

export type OidcMock = {
  /** With trailing slash, as Auth0 issues it. */
  issuer: string;
  /** Claims merged over the defaults of every ID token issued from now on. */
  setClaims(claims: JWTPayload): void;
  close(): Promise<void>;
};

type Grant = {
  redirectUri: string;
  challenge: string;
  nonce: string | null;
  email: string;
  connection: string;
};

const KID = 'mock-1';

export async function startOidcMock(opts: {
  clientId: string;
  clientSecret: string;
  port?: number;
  host?: string;
}): Promise<OidcMock> {
  const host = opts.host ?? '127.0.0.1';
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: KID,
    alg: 'ES256',
    use: 'sig',
  };
  const grants = new Map<string, Grant>();
  let overrides: JWTPayload = {};
  let issuer = '';

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', issuer);
    if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
      return json(res, 200, { keys: [jwk] });
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri');
      const challenge = q.get('code_challenge');
      if (
        q.get('client_id') !== opts.clientId ||
        q.get('response_type') !== 'code' ||
        q.get('code_challenge_method') !== 'S256' ||
        !challenge ||
        !redirectUri ||
        !q.get('state')
      ) {
        return json(res, 400, { error: 'invalid_request' });
      }
      const code = randomBytes(16).toString('base64url');
      grants.set(code, {
        redirectUri,
        challenge,
        nonce: q.get('nonce'),
        email: q.get('login_hint') ?? 'dev@example.com',
        connection: q.get('connection') ?? 'email',
      });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state')!);
      res.writeHead(302, { Location: back.toString() }).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      const body = new URLSearchParams(await readBody(req));
      const code = body.get('code') ?? '';
      const grant = grants.get(code);
      grants.delete(code); // single use, also on failure
      const verifier = body.get('code_verifier') ?? '';
      if (
        body.get('grant_type') !== 'authorization_code' ||
        body.get('client_id') !== opts.clientId ||
        body.get('client_secret') !== opts.clientSecret ||
        !grant ||
        body.get('redirect_uri') !== grant.redirectUri ||
        createHash('sha256').update(verifier).digest('base64url') !==
          grant.challenge
      ) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      const now = Math.floor(Date.now() / 1000);
      const subject = createHash('sha256')
        .update(grant.email)
        .digest('hex')
        .slice(0, 24);
      const idToken = await new SignJWT({
        iss: issuer,
        aud: opts.clientId,
        sub: `${grant.connection}|${subject}`,
        email: grant.email,
        email_verified: true,
        iat: now,
        exp: now + 600,
        ...(grant.nonce ? { nonce: grant.nonce } : {}),
        ...overrides,
      })
        .setProtectedHeader({ alg: 'ES256', kid: KID, typ: 'JWT' })
        .sign(privateKey);
      return json(res, 200, {
        access_token: randomBytes(16).toString('base64url'),
        id_token: idToken,
        token_type: 'Bearer',
        expires_in: 600,
      });
    }
    json(res, 404, { error: 'not_found' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => json(res, 500, { error: 'server_error' }));
  });
  await new Promise<void>((resolve) =>
    server.listen(opts.port ?? 0, host, resolve),
  );
  const { port } = server.address() as AddressInfo;
  issuer = `http://${host}:${port}/`;

  return {
    issuer,
    setClaims: (claims): void => {
      overrides = claims;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Array<Buffer> = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

if (require.main === module) {
  void startOidcMock({
    clientId: process.env.ORG_OIDC_CLIENT_ID ?? 'dev-client',
    clientSecret: process.env.ORG_OIDC_CLIENT_SECRET ?? 'dev-secret',
    port: Number(process.env.ORG_OIDC_MOCK_PORT ?? 4010),
  }).then(({ issuer }) => {
    process.stdout.write(`OIDC mock issuer: ${issuer}\n`);
  });
}
