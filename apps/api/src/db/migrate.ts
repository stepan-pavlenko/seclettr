/**
 * Simple migration runner.
 * Reads SQL files from infra/migrations/ in alphabetical order
 * and runs any that haven't been applied yet.
 *
 * In local isolated docker dev, Postgres may already be initialized from
 * /docker-entrypoint-initdb.d before this runner executes. To avoid failing on
 * duplicate schema creation, we baseline only the migrations whose schema
 * signatures are already present, then continue applying any newer files.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../../../infra/migrations");

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString });

async function tableExists(tableName: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [`public.${tableName}`]
  );
  return result.rows[0]?.exists === true;
}

async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = $2
      ) AS exists
    `,
    [tableName, columnName]
  );
  return result.rows[0]?.exists === true;
}

async function constraintExists(tableName: string, constraintName: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_constraint c
        INNER JOIN pg_class t ON t.oid = c.conrelid
        INNER JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = $1
          AND c.conname = $2
      ) AS exists
    `,
    [tableName, constraintName]
  );
  return result.rows[0]?.exists === true;
}

async function indexExists(indexName: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = $1
     ) AS exists`,
    [indexName]
  );
  return result.rows[0]?.exists === true;
}

async function columnIsNullable(tableName: string, columnName: string): Promise<boolean> {
  const result = await client.query<{ is_nullable: string }>(
    `
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
    `,
    [tableName, columnName]
  );
  return result.rows[0]?.is_nullable === "YES";
}

const baselineChecks: Record<string, () => Promise<boolean>> = {
  "001_initial.sql": async () => {
    const requiredTables = [
      "users",
      "devices",
      "messages",
      "groups",
      "group_members",
      "call_sessions",
      "attachments",
    ];
    for (const tableName of requiredTables) {
      if (!(await tableExists(tableName))) {
        return false;
      }
    }
    return true;
  },
  "002_fix_message_idempotency.sql": async () =>
    constraintExists("messages", "messages_client_message_id_device_unique"),
  "003_attachment_access.sql": async () => tableExists("attachment_access"),
  "004_push_subscriptions.sql": async () => tableExists("push_subscriptions"),
  "005_group_member_roles.sql": async () =>
    (await columnExists("group_members", "role")) &&
    (await constraintExists("group_members", "group_members_role_check")),
  "006_message_read_receipts.sql": async () =>
    columnExists("messages", "read_at"),
  "007_groups_creator_id_nullable.sql": async () =>
    columnIsNullable("groups", "creator_id"),
  "008_push_preferences.sql": async () =>
    tableExists("push_preferences"),
  "009_direct_relationships.sql": async () =>
    tableExists("direct_relationships"),
  "010_otk_reservations.sql": async () =>
    columnExists("one_time_prekeys", "reserved_at"),
  "011_retention_indices.sql": async () =>
    indexExists("messages_delivered_created_at"),
  "012_group_messages_aead_version.sql": async () =>
    columnExists("group_messages", "aead_version"),
  "013_group_members_group_id_index.sql": async () =>
    indexExists("gm_group_active"),
  "014_call_sessions_integrity.sql": async () =>
    constraintExists("call_sessions", "cs_call_target_xor"),
  "015_audit_log.sql": async () => tableExists("audit_log"),
  "016_attachment_upload_state.sql": async () =>
    columnExists("attachments", "upload_state"),
  "017_group_crypto_epoch.sql": async () =>
    (await columnExists("groups", "crypto_epoch")) &&
    (await columnExists("group_messages", "crypto_epoch")),
  "018_standalone_rooms.sql": async () =>
    tableExists("room_invites"),
  "019_room_invite_token_hash.sql": async () =>
    columnExists("room_invites", "token_hash"),
  "020_transfer_packages.sql": async () =>
    tableExists("transfer_packages"),
  "021_plain_chats.sql": async () =>
    tableExists("plain_groups"),
  "022_plain_attachment_lifecycle.sql": async () =>
    indexExists("pa_deleted_at"),
  "023_plain_chat_pins.sql": async () =>
    tableExists("plain_chat_pins"),
  "024_plain_chat_folders.sql": async () =>
    tableExists("plain_chat_folders"),
  "025_background_poll_tokens.sql": async () =>
    tableExists("background_poll_tokens"),
  "026_user_profiles.sql": async () =>
    columnExists("users", "display_name"),
  "027_plain_group_profiles.sql": async () =>
    (await columnExists("plain_groups", "avatar_key")) &&
    (await columnExists("plain_groups", "description")),
  "028_background_poll_token_expiry.sql": async () =>
    columnExists("background_poll_tokens", "expires_at"),
  "029_fcm_device_tokens.sql": async () =>
    tableExists("push_device_tokens"),
};

async function baselineBootstrappedMigrations(files: string[]): Promise<void> {
  let baselinedCount = 0;
  for (const file of files) {
    const isAlreadyApplied = baselineChecks[file];
    if (!isAlreadyApplied) {
      continue;
    }
    const alreadyRecorded = await client.query(
      "SELECT 1 FROM _migrations WHERE filename = $1",
      [file]
    );
    if ((alreadyRecorded.rowCount ?? 0) > 0) {
      continue;
    }
    if (!(await isAlreadyApplied())) {
      continue;
    }
    await client.query(
      "INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING",
      [file]
    );
    baselinedCount += 1;
  }

  if (baselinedCount > 0) {
    console.log(`  baseline ${baselinedCount} existing migration(s)`);
  }
}

async function run() {
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         SERIAL PRIMARY KEY,
      filename   TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  await baselineBootstrappedMigrations(files);

  for (const file of files) {
    const applied = await client.query(
      "SELECT 1 FROM _migrations WHERE filename = $1",
      [file]
    );
    if ((applied.rowCount ?? 0) > 0) {
      console.log(`  skip  ${file}`);
      continue;
    }

    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    console.log(`  apply ${file} ...`);
    await client.query(sql);
    await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
    console.log(`  done  ${file}`);
  }

  await client.end();
  console.log("Migrations complete");
}

try {
  await run();
} catch (err) {
  await client.end().catch(() => undefined);
  console.error("Migration failed:", err);
  process.exit(1);
}
