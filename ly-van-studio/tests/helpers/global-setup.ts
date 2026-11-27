import { execSync } from 'node:child_process';
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://lyvan:lyvan@localhost:5432/lyvan_test';
  execSync('npx tsx scripts/migrate.ts --reset', { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
}
