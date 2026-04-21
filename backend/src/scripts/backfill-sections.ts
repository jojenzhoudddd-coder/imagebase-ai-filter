import { PrismaClient } from "../generated/prisma/client.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { extractIdeaSections } from "../services/ideaSections.js";
import { config } from "dotenv";
config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const ideas = await prisma.idea.findMany({ select: { id: true, content: true, name: true } });
  console.log(`Found ${ideas.length} ideas to backfill`);
  for (const i of ideas) {
    const sections = extractIdeaSections(i.content);
    await prisma.idea.update({
      where: { id: i.id },
      data: { sections: sections as unknown as any },
    });
    console.log(`  ${i.name}: ${sections.length} sections`);
  }
  await prisma.$disconnect();
  await pool.end();
}
main().catch(err => { console.error(err); process.exit(1); });
