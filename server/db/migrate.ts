// Standalone CLI database migration runner: `npm run db:migrate`
import { MySqlClient } from "./client.ts";

async function main() {
  const client = new MySqlClient();
  if (!client.configured) {
    console.error("Cannot migrate: neither DATABASE_URL nor MYSQL_HOST is configured in the environment.");
    process.exit(1);
  }
  try {
    const { applied } = await client.migrate();
    if (applied.length) {
      console.log(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
    } else {
      console.log("Database schema is already up to date.");
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("Migration failed:", (err as Error).message);
  process.exit(1);
});
