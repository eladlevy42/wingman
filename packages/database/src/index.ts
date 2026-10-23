import { PrismaClient } from "../generated/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// The schema's datasource url is hardcoded, so there is no env var Prisma reads
// on its own. E2E_DATABASE_URL points one process at a throwaway SQLite file
// instead — the apps/mobile full-run E2E (#564) starts the api against a fresh,
// unseeded database this way. Unset everywhere else, so dev is unchanged.
const e2eDatabaseUrl = process.env.E2E_DATABASE_URL;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient(e2eDatabaseUrl ? { datasources: { db: { url: e2eDatabaseUrl } } } : undefined);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export * from "../generated/client";
export { EXPECTED_MATCHES_PER_USER } from "./seedData";
export {
  deleteUserAccount,
  deleteUserAccounts,
  DELETED_USER_ID,
  type UserDeletionMode,
  type UserDeletionResult,
} from "./userDeletion";
