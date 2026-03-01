import { Pool, type PoolClient } from 'pg';

export type SearchFilters = {
  q?: string;
  folder?: string;
  after?: string;
  before?: string;
  from?: string;
  to?: string;
};

export type MessagePreview = {
  id: string;
  subject: string | null;
  from: string | null;
  to: string | null;
  date: string | null;
  folder: string;
  snippet: string | null;
};

export const MAX_LIMIT = 20;

export function createDbPool(databaseUrl = process.env.DATABASE_URL): Pool {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  return new Pool({ connectionString: databaseUrl });
}

export async function listFolders(client: Pool | PoolClient, accountId: string) {
  const result = await client.query(
    `SELECT f.id, f.name, f.last_uid, f.uidvalidity, f.uidnext, COUNT(m.id)::int AS message_count
     FROM folders f
     LEFT JOIN messages m ON m.folder_id = f.id
     WHERE f.account_id = $1
     GROUP BY f.id
     ORDER BY f.name ASC`,
    [accountId],
  );
  return result.rows;
}

export async function getMessage(client: Pool | PoolClient, accountId: string, id: string) {
  const result = await client.query(
    `SELECT m.id, m.subject, m.from_addr, m.to_addrs, m.msg_date, m.flags, m.snippet,
            left(m.body_text, 4096) AS body_preview, m.thread_key, f.name AS folder
     FROM messages m
     INNER JOIN folders f ON f.id = m.folder_id
     WHERE m.account_id = $1 AND m.id = $2
     LIMIT 1`,
    [accountId, id],
  );
  return result.rows[0] ?? null;
}

export async function searchMessages(
  client: Pool | PoolClient,
  accountId: string,
  filters: SearchFilters,
  limit: number,
  offset: number,
): Promise<MessagePreview[]> {
  const boundedLimit = Math.min(Math.max(limit || 20, 1), MAX_LIMIT);
  const boundedOffset = Math.max(offset || 0, 0);

  const clauses = ['m.account_id = $1'];
  const params: Array<string | number | Date> = [accountId];

  if (filters.q) {
    params.push(filters.q);
    clauses.push(`m.fts @@ plainto_tsquery('simple', $${params.length})`);
  }
  if (filters.folder) {
    params.push(filters.folder);
    clauses.push(`f.name = $${params.length}`);
  }
  if (filters.after) {
    params.push(new Date(filters.after));
    clauses.push(`m.msg_date >= $${params.length}`);
  }
  if (filters.before) {
    params.push(new Date(filters.before));
    clauses.push(`m.msg_date <= $${params.length}`);
  }
  if (filters.from) {
    params.push(`%${filters.from}%`);
    clauses.push(`m.from_addr ILIKE $${params.length}`);
  }
  if (filters.to) {
    params.push(`%${filters.to}%`);
    clauses.push(`m.to_addrs ILIKE $${params.length}`);
  }

  params.push(boundedLimit, boundedOffset);

  const result = await client.query(
    `SELECT m.id, m.subject, m.from_addr AS "from", m.to_addrs AS "to", m.msg_date::text AS date,
            f.name AS folder, left(m.snippet, 280) AS snippet
     FROM messages m
     INNER JOIN folders f ON f.id = m.folder_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY m.msg_date DESC NULLS LAST
     LIMIT $${params.length - 1}
     OFFSET $${params.length}`,
    params,
  );

  return result.rows;
}

export async function getRawMime(client: Pool | PoolClient, accountId: string, id: string) {
  const result = await client.query(
    'SELECT raw_mime FROM messages WHERE account_id = $1 AND id = $2 LIMIT 1',
    [accountId, id],
  );
  return result.rows[0]?.raw_mime ?? null;
}
