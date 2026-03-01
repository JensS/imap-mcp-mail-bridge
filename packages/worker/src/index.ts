import { ImapFlow } from 'imapflow';
import Redis from 'ioredis';
import { createDbPool } from '@imap-mcp/db';

type Account = {
  id: string;
  imap_host: string;
  imap_user: string;
  imap_pass_enc: Buffer;
  imap_port: number;
  imap_tls: boolean;
};

const syncIntervalMs = Number(process.env.SYNC_INTERVAL_SECONDS ?? '20') * 1000;
const syncConcurrency = Number(process.env.SYNC_CONCURRENCY ?? '4');

function decodePassword(encrypted: Buffer): string {
  return encrypted.toString('utf8');
}

function buildSnippet(source: string): string {
  return source.replace(/\s+/g, ' ').trim().slice(0, 280);
}

function buildThreadKey(messageId?: string | null, inReplyTo?: string | null, references?: string | null): string | null {
  const normalized = (inReplyTo || references || messageId || '').trim();
  return normalized.length > 0 ? normalized.slice(0, 255) : null;
}

async function invalidateCaches(redis: Redis, accountId: string, messageIds: string[]) {
  const searchCursorKeys = await redis.keys(`search:${accountId}:*`);
  if (searchCursorKeys.length > 0) {
    await redis.del(searchCursorKeys);
  }
  if (messageIds.length > 0) {
    const keys = messageIds.map((id) => `msg:${accountId}:${id}`);
    await redis.del(keys);
  }
}

async function syncFolder(client: ImapFlow, db: ReturnType<typeof createDbPool>, redis: Redis, account: Account, folderName: string) {
  const lock = await client.getMailboxLock(folderName);
  try {
    const status = await client.status(folderName, { uidValidity: true, uidNext: true });
    const folderResult = await db.query(
      `INSERT INTO folders(account_id, name, uidvalidity, uidnext, last_uid, updated_at)
       VALUES ($1, $2, $3, $4, 0, now())
       ON CONFLICT (account_id, name)
       DO UPDATE SET uidnext = EXCLUDED.uidnext, updated_at = now()
       RETURNING id, uidvalidity, last_uid`,
      [account.id, folderName, status.uidValidity ?? null, status.uidNext ?? null],
    );

    const folder = folderResult.rows[0] as { id: string; uidvalidity: string | null; last_uid: string };
    let lastUid = Number(folder.last_uid ?? 0);

    if (folder.uidvalidity !== null && Number(folder.uidvalidity) !== Number(status.uidValidity)) {
      await db.query('DELETE FROM messages WHERE account_id = $1 AND folder_id = $2', [account.id, folder.id]);
      lastUid = 0;
      await db.query('UPDATE folders SET uidvalidity = $3, last_uid = 0 WHERE account_id = $1 AND id = $2', [account.id, folder.id, status.uidValidity ?? null]);
    }

    const fetchedMessageIds: string[] = [];
    for await (const message of client.fetch(`${lastUid + 1}:*`, {
      uid: true,
      envelope: true,
      flags: true,
      size: true,
      internalDate: true,
      source: true,
      bodyStructure: true,
    })) {
      const sourceText = message.source ? message.source.toString('utf8') : '';
      const bodyText = sourceText.slice(0, 65536);
      const snippet = buildSnippet(bodyText);
      const from = message.envelope?.from?.map((f) => `${f.name ?? ''} <${f.address ?? ''}>`).join(', ') ?? null;
      const to = message.envelope?.to?.map((f) => `${f.name ?? ''} <${f.address ?? ''}>`).join(', ') ?? null;
      const subject = message.envelope?.subject ?? null;
      const messageId = message.envelope?.messageId ?? null;
      const threadKey = buildThreadKey(messageId, null, null);

      const upsert = await db.query(
        `INSERT INTO messages(account_id, folder_id, uid, internal_date, msg_date, from_addr, to_addrs, subject,
                              message_id, in_reply_to, references, flags, size, snippet, body_text, thread_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (account_id, folder_id, uid)
         DO UPDATE SET internal_date = EXCLUDED.internal_date,
                      msg_date = EXCLUDED.msg_date,
                      from_addr = EXCLUDED.from_addr,
                      to_addrs = EXCLUDED.to_addrs,
                      subject = EXCLUDED.subject,
                      message_id = EXCLUDED.message_id,
                      flags = EXCLUDED.flags,
                      size = EXCLUDED.size,
                      snippet = EXCLUDED.snippet,
                      body_text = EXCLUDED.body_text,
                      thread_key = EXCLUDED.thread_key
         RETURNING id`,
        [
          account.id,
          folder.id,
          message.uid,
          message.internalDate ?? null,
          message.envelope?.date ?? null,
          from,
          to,
          subject,
          messageId,
          null,
          null,
          [...(message.flags ?? [])],
          message.size ?? null,
          snippet,
          bodyText,
          threadKey,
        ],
      );
      fetchedMessageIds.push(upsert.rows[0].id as string);
      lastUid = Math.max(lastUid, message.uid);
    }

    await db.query(
      'UPDATE folders SET last_uid = $3, uidvalidity = $4, uidnext = $5, updated_at = now() WHERE account_id = $1 AND id = $2',
      [account.id, folder.id, lastUid, status.uidValidity ?? null, status.uidNext ?? null],
    );

    await invalidateCaches(redis, account.id, fetchedMessageIds);
  } finally {
    lock.release();
  }
}

async function syncAccount(db: ReturnType<typeof createDbPool>, redis: Redis, account: Account) {
  const imap = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: account.imap_tls,
    auth: {
      user: account.imap_user,
      pass: decodePassword(account.imap_pass_enc),
    },
    socketTimeout: 30_000,
    logger: false,
  });

  try {
    await imap.connect();
    const listing = await imap.list();
    const folders = listing.map((f) => f.path).filter(Boolean);

    for (const folderName of folders) {
      await syncFolder(imap, db, redis, account, folderName);
    }
  } finally {
    if (!imap.closed) {
      await imap.logout();
    }
  }
}

async function poll() {
  const db = createDbPool();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  console.log(JSON.stringify({ msg: 'worker started', syncConcurrency, syncIntervalMs }));

  while (true) {
    try {
      const result = await db.query<Account>(
        'SELECT id, imap_host, imap_user, imap_pass_enc, imap_port, imap_tls FROM accounts ORDER BY created_at ASC',
      );

      const batches: Promise<void>[] = [];
      for (const account of result.rows) {
        const job = syncAccount(db, redis, account).catch((error: unknown) => {
          console.error(JSON.stringify({ level: 'error', accountId: account.id, msg: 'sync failed', error: String(error) }));
        });
        batches.push(job);
        if (batches.length >= syncConcurrency) {
          await Promise.allSettled(batches);
          batches.length = 0;
        }
      }
      if (batches.length > 0) {
        await Promise.allSettled(batches);
      }
      console.log(JSON.stringify({ msg: 'worker heartbeat', ts: new Date().toISOString() }));
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', msg: 'poll loop failed', error: String(error) }));
    }

    await new Promise((resolve) => setTimeout(resolve, syncIntervalMs));
  }
}

poll().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
