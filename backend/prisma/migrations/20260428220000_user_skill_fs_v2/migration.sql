-- Skill Creator V2: fs-first.
-- DB 只保留薄索引,内容下沉到 SKILL.md + workflows/*.json (BlobStorage 下)。
--
-- prod 在此 migration 部署前 user_skills 表 0 行(V1 刚上线半天还没人用),
-- 所以不做 V1→V2 数据搬运,直接 schema 替换。如果未来反悔,从 V1 恢复
-- 也只需读 SKILL.md → 写回旧字段,逻辑等价。

ALTER TABLE "user_skills"
  ADD COLUMN "dirPath" TEXT NOT NULL DEFAULT '',
  DROP COLUMN "description",
  DROP COLUMN "triggers",
  DROP COLUMN "promptFragment",
  DROP COLUMN "workflowDocs",
  DROP COLUMN "toolWhitelist",
  DROP COLUMN "sourceConversationId",
  DROP COLUMN "sourceWorkflowRunId";

-- 去掉 default 后强制 NOT NULL —— 后续每次 INSERT 必须显式给 dirPath
ALTER TABLE "user_skills" ALTER COLUMN "dirPath" DROP DEFAULT;
