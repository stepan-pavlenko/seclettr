import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../../../infra/migrations");
const MIGRATE_SOURCE = join(__dirname, "../db/migrate.ts");

/**
 * Guards AUDIT.md Medium: the baseline map in `migrate.ts` previously omitted
 * migrations 015/027/029. A missing entry means a pre-bootstrapped database
 * will re-run that migration (and, if it is not idempotent, fail to start).
 */
describe("migration baseline coverage", () => {
  it("has a baseline check for every migration file", async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((name) =>
      name.endsWith(".sql")
    );
    const source = await readFile(MIGRATE_SOURCE, "utf8");
    const missing = files.filter((file) => !source.includes(`"${file}"`));
    expect(missing).toEqual([]);
  });
});