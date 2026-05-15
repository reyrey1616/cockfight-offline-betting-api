-- CreateTable
CREATE TABLE "SessionReset" (
    "id" TEXT NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performedByUserId" TEXT NOT NULL,
    "fightCount" INTEGER NOT NULL,
    "betCount" INTEGER NOT NULL,
    "ledgerCount" INTEGER NOT NULL,
    "notes" TEXT,
    "forced" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SessionReset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionReset_performedAt_idx" ON "SessionReset"("performedAt");

-- CreateIndex
CREATE INDEX "SessionReset_performedByUserId_performedAt_idx" ON "SessionReset"("performedByUserId", "performedAt");

-- AddForeignKey
ALTER TABLE "SessionReset" ADD CONSTRAINT "SessionReset_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
