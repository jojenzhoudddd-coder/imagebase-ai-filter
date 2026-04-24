/**
 * migrate-seed-user — one-shot CLI: 把历史 seed user（`user_default`）
 * 的 email / username / name / passwordHash 改成你真实的账号，并把
 * 对应的 org 和 workspace 名字也改成 `<username>`。
 *
 * 不改 user.id，所以所有已有 artifact（table / idea / design / demo /
 * agent / conversation）仍然通过 `user_default` 这个 id 关联、全部保留。
 *
 * 用法：
 *   cd backend
 *   npx tsx src/scripts/migrate-seed-user.ts \
 *     --email=you@example.com \
 *     --username=yourname \
 *     --password=Your_Password_6plus \
 *     [--user-id=user_default]     # 可选，默认 user_default
 *     [--workspace-id=doc_default] # 可选，默认 doc_default
 *     [--dry-run]                  # 只打印不改库
 *
 * 幂等性：同样参数跑第二次不会报错（会覆盖到一致状态）。
 */

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { hashPassword } from "../services/authService.js";

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq === -1) {
      out[a.slice(2)] = true;
    } else {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = String(args.email || "").trim().toLowerCase();
  const username = String(args.username || "").trim();
  const password = String(args.password || "");
  const userId = String(args["user-id"] || "user_default");
  const workspaceId = String(args["workspace-id"] || "doc_default");
  const dryRun = Boolean(args["dry-run"]);

  if (!EMAIL_RE.test(email)) {
    console.error(`✗ --email 无效：${email || "(空)"}`);
    process.exit(1);
  }
  if (!USERNAME_RE.test(username)) {
    console.error(`✗ --username 无效（需 2-32 位 [A-Za-z0-9_-]）：${username || "(空)"}`);
    process.exit(1);
  }
  if (password.length < 6) {
    console.error(`✗ --password 至少 6 位`);
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      console.error(`✗ 没找到 user id = ${userId}`);
      process.exit(1);
    }

    // email 唯一性冲突检查（username 不唯一，不用查）
    const emailOwner = await prisma.user.findUnique({ where: { email } });
    if (emailOwner && emailOwner.id !== userId) {
      console.error(`✗ email ${email} 已被 user ${emailOwner.id} 注册，取消`);
      process.exit(1);
    }

    console.log("准备更新：");
    console.log(`  user.id          = ${userId} (保持不变)`);
    console.log(`  user.email       = ${user.email} → ${email}`);
    console.log(`  user.username    = ${user.username} → ${username}`);
    console.log(`  user.name        = ${user.name} → ${username}`);
    console.log(`  user.passwordHash = ${user.passwordHash ? "(existing)" : "(null)"} → <new bcrypt>`);

    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    const workspaceName = `${username}'s Workspace`;
    if (ws) {
      console.log(`  workspace.name   = ${ws.name} → ${workspaceName}`);
      const org = await prisma.org.findUnique({ where: { id: ws.orgId } });
      if (org) {
        console.log(`  org.name         = ${org.name} → ${username} 的空间`);
      }
    } else {
      console.log(`  (没找到 workspace ${workspaceId}，只改 user 行)`);
    }

    if (dryRun) {
      console.log("\n(--dry-run) 不实际写库");
      process.exit(0);
    }

    const passwordHash = await hashPassword(password);

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          email,
          username,
          name: username,
          passwordHash,
        },
      });
      if (ws) {
        await tx.workspace.update({
          where: { id: workspaceId },
          data: { name: workspaceName },
        });
        await tx.org.update({
          where: { id: ws.orgId },
          data: { name: `${username} 的空间` },
        });
      }
    });

    console.log("\n✓ 完成。现在可以用新邮箱 + 密码登录了。");
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("✗ 脚本出错：", err);
  process.exit(1);
});
