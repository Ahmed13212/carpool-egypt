import { loadDotEnv, loadEnv } from '../config/env';
import { migrate } from '../database/migrator';

async function main() {
  loadDotEnv();
  const env = loadEnv();
  const applied = await migrate(env.DATABASE_URL);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations');
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
