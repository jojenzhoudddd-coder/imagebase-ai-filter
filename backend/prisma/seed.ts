import { mockTable } from "../src/mockData.js";
import { connectDB, loadTable, disconnectDB } from "../src/services/dbStore.js";

async function main() {
  console.log("Connecting to database...");
  await connectDB();

  console.log("Seeding mock data...");
  await loadTable(mockTable);

  console.log(`Seeded table "${mockTable.name}" with ${mockTable.fields.length} fields and ${mockTable.records.length} records.`);

  await disconnectDB();
  console.log("Done.");
}

main().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});
