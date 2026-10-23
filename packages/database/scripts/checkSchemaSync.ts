import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const schemaPath = join(__dirname, "..", "prisma", "schema.prisma");
const hashPath = join(__dirname, "..", "generated", "client", ".schema-hash");

const currentHash = createHash("sha256").update(readFileSync(schemaPath)).digest("hex");
const storedHash = existsSync(hashPath) ? readFileSync(hashPath, "utf-8").trim() : null;

if (storedHash !== currentHash) {
  console.error(
    "\n[@wingman/database] Generated Prisma client is missing or out of sync with schema.prisma.\n" +
      "Run `pnpm db:generate` before starting dev/build.\n"
  );
  process.exit(1);
}
