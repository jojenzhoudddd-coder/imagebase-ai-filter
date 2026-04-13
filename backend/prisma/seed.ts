import "dotenv/config";
import { mockTable, mockHistoryTable } from "../src/mockData.js";
import { connectDB, loadTable, disconnectDB } from "../src/services/dbStore.js";

async function main() {
  console.log("Connecting to database...");
  await connectDB();

  console.log("Seeding mock data...");
  await loadTable(mockTable);
  console.log(`  ✓ ${mockTable.name}: ${mockTable.fields.length} fields, ${mockTable.records.length} records`);

  await loadTable(mockHistoryTable);
  console.log(`  ✓ ${mockHistoryTable.name}: ${mockHistoryTable.fields.length} fields, ${mockHistoryTable.records.length} records`);

  await disconnectDB();
  console.log("Done.");
}

main().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});
