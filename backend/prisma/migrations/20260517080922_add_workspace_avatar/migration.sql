-- AlterTable
ALTER TABLE "agent_integration_credentials" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "agent_integrations" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "avatarUrl" TEXT;
