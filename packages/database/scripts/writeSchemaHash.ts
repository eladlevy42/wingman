import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const schemaPath = join(__dirname, "..", "prisma", "schema.prisma");
const hashPath = join(__dirname, "..", "generated", "client", ".schema-hash");

const hash = createHash("sha256").update(readFileSync(schemaPath)).digest("hex");
writeFileSync(hashPath, hash);
