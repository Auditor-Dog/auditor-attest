-- Corpus 7.7.5 depths: standard (/auditor:audit) and quick (/auditor:quick-scan).
ALTER TABLE "Job" ADD COLUMN "depth" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "Report" ADD COLUMN "depth" TEXT NOT NULL DEFAULT 'standard';

DROP INDEX IF EXISTS "Report_owner_repo_commit_corpusVersion_model_key";
CREATE UNIQUE INDEX "Report_owner_repo_commit_corpusVersion_model_depth_key" ON "Report"("owner", "repo", "commit", "corpusVersion", "model", "depth");
