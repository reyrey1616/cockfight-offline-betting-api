-- Track collector-only cash rows (deposits + remits) on session reset audit rows.
ALTER TABLE "SessionReset" ADD COLUMN "collectorCashCount" INTEGER;
