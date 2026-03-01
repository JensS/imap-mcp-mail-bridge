import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const oauthIssuer = process.env.OAUTH_ISSUER;
const oauthAudience = process.env.OAUTH_AUDIENCE ?? process.env.BASE_URL;

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export type AuthContext = {
  accountId: string;
  token: JWTPayload;
};

export async function validateBearer(authHeader: string | undefined): Promise<AuthContext> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('missing bearer token');
  }
  if (!oauthIssuer) {
    throw new Error('OAUTH_ISSUER is required');
  }
  if (!oauthAudience) {
    throw new Error('OAUTH_AUDIENCE or BASE_URL is required');
  }

  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${oauthIssuer.replace(/\/$/, '')}/.well-known/jwks.json`));
  }

  const token = authHeader.slice('Bearer '.length);
  const verified = await jwtVerify(token, jwks, {
    issuer: oauthIssuer,
    audience: oauthAudience,
  });

  const accountId = String(verified.payload.sub ?? '');
  if (!accountId) {
    throw new Error('token missing subject');
  }

  return {
    accountId,
    token: verified.payload,
  };
}
