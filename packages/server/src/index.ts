import Fastify from 'fastify';
import Redis from 'ioredis';
import { z } from 'zod';
import { createDbPool, getMessage, getRawMime, listFolders, searchMessages } from '@imap-mcp/db';
import { validateBearer } from './auth.js';

const app = Fastify({ logger: true });
const db = createDbPool();
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const baseUrl = process.env.BASE_URL ?? 'http://localhost:3000';
const oauthIssuer = process.env.OAUTH_ISSUER ?? 'https://auth.example.com';
const reqPerMinute = Number(process.env.RATE_LIMIT_PER_MINUTE ?? '60');

const searchInputSchema = z.object({
  q: z.string().optional(),
  folder: z.string().optional(),
  after: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(20),
  offset: z.number().int().min(0).default(0),
});

const getInputSchema = z.object({ id: z.string().uuid() });

async function enforceRateLimit(accountId: string) {
  const minuteBucket = new Date().toISOString().slice(0, 16);
  const key = `rl:${accountId}:${minuteBucket}`;
  const value = await redis.incr(key);
  if (value === 1) {
    await redis.expire(key, 120);
  }
  if (value > reqPerMinute) {
    throw new Error('rate limit exceeded');
  }
}

async function getAuthContextOrReply(request: Parameters<typeof app.post>[1] extends never ? never : any, reply: any) {
  try {
    const auth = await validateBearer(request.headers.authorization);
    await enforceRateLimit(auth.accountId);
    return auth;
  } catch {
    reply
      .code(401)
      .header('WWW-Authenticate', `Bearer realm="imap-mcp", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`)
      .send({ error: 'unauthorized' });
    return null;
  }
}

app.get('/healthz', async () => ({ ok: true }));

app.get('/.well-known/oauth-protected-resource', async () => ({
  resource: baseUrl,
  authorization_servers: [oauthIssuer],
  scopes_supported: ['mail.read', 'mail.search'],
}));

app.post('/mcp', async (request, reply) => {
  const auth = await getAuthContextOrReply(request, reply);
  if (!auth) return;

  const body = request.body as {
    method?: string;
    params?: Record<string, unknown>;
    id?: string | number;
  };

  if (!body?.method) {
    return reply.code(400).send({ error: 'invalid request' });
  }

  if (body.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: body.id ?? null,
      result: {
        tools: [
          { name: 'mail_list_folders', description: 'List folders for the current account', inputSchema: { type: 'object', properties: {} } },
          { name: 'mail_search', description: 'Search indexed mail', inputSchema: { type: 'object' } },
          { name: 'mail_get', description: 'Get message preview by id', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
        ],
        resources: [
          { uriTemplate: 'mail://raw/{id}', name: 'mail_raw', description: 'Raw MIME for a message' },
        ],
      },
    };
  }

  if (body.method === 'tools/call') {
    const name = String(body.params?.name ?? '');
    const args = (body.params?.arguments ?? {}) as Record<string, unknown>;

    if (name === 'mail_list_folders') {
      const folders = await listFolders(db, auth.accountId);
      return { jsonrpc: '2.0', id: body.id ?? null, result: { content: [{ type: 'json', json: folders }] } };
    }

    if (name === 'mail_search') {
      const parsed = searchInputSchema.safeParse(args);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const key = `search:${auth.accountId}:${Buffer.from(JSON.stringify(parsed.data)).toString('base64url')}`;
      const cached = await redis.get(key);
      if (cached) {
        return { jsonrpc: '2.0', id: body.id ?? null, result: { content: [{ type: 'json', json: JSON.parse(cached) }] } };
      }
      const rows = await searchMessages(db, auth.accountId, parsed.data, parsed.data.limit, parsed.data.offset);
      await redis.setex(key, 60, JSON.stringify(rows));
      return { jsonrpc: '2.0', id: body.id ?? null, result: { content: [{ type: 'json', json: rows }] } };
    }

    if (name === 'mail_get') {
      const parsed = getInputSchema.safeParse(args);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const key = `msg:${auth.accountId}:${parsed.data.id}`;
      const cached = await redis.get(key);
      if (cached) {
        return { jsonrpc: '2.0', id: body.id ?? null, result: { content: [{ type: 'json', json: JSON.parse(cached) }] } };
      }
      const row = await getMessage(db, auth.accountId, parsed.data.id);
      if (!row) {
        return reply.code(404).send({ error: 'not found' });
      }
      await redis.setex(key, 900, JSON.stringify(row));
      return { jsonrpc: '2.0', id: body.id ?? null, result: { content: [{ type: 'json', json: row }] } };
    }

    if (name === 'mail_raw') {
      const parsed = getInputSchema.safeParse(args);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const rawMime = await getRawMime(db, auth.accountId, parsed.data.id);
      return { jsonrpc: '2.0', id: body.id ?? null, result: { content: [{ type: 'text', text: rawMime ?? '' }] } };
    }

    return reply.code(404).send({ error: `unknown tool ${name}` });
  }

  if (body.method === 'resources/read') {
    const uri = String(body.params?.uri ?? '');
    const match = /^mail:\/\/raw\/(.+)$/.exec(uri);
    if (!match) {
      return reply.code(400).send({ error: 'invalid resource uri' });
    }
    const id = match[1];
    const rawMime = await getRawMime(db, auth.accountId, id);
    return {
      jsonrpc: '2.0',
      id: body.id ?? null,
      result: {
        contents: [{ uri, mimeType: 'message/rfc822', text: rawMime ?? '' }],
      },
    };
  }

  return reply.code(404).send({ error: `unknown method ${body.method}` });
});

const port = Number(process.env.PORT ?? '3000');
app.listen({ port, host: '0.0.0.0' }).catch((error) => {
  app.log.error(error);
  process.exitCode = 1;
});
