import 'dotenv/config';

import path from 'node:path';

import { defineConfig } from 'prisma/config';

const provider = process.env.DATABASE_PROVIDER ?? 'postgresql';

const schemaFile =
  provider === 'mysql'
    ? 'mysql-schema.prisma'
    : provider === 'psql_bouncer'
      ? 'psql_bouncer-schema.prisma'
      : 'postgresql-schema.prisma';

const databaseUrl = process.env.DATABASE_URL ?? process.env.DATABASE_CONNECTION_URI;

if (!databaseUrl) {
  throw new Error('DATABASE_URL or DATABASE_CONNECTION_URI must be set before running Prisma.');
}

export default defineConfig({
  schema: path.join('prisma', schemaFile),
  // Os scripts db:* copiam as migrations do provider ativo para prisma/migrations
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  datasource: {
    url: databaseUrl,
  },
});
