-- CreateEnum
CREATE TYPE "BetSide" AS ENUM ('MERON', 'WALA');

-- CreateEnum
CREATE TYPE "BetStatus" AS ENUM ('PENDING', 'WON', 'LOST', 'PAID', 'VOIDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "FightStatus" AS ENUM ('SCHEDULED', 'OPEN', 'CLOSED', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FightOutcome" AS ENUM ('MERON', 'WALA', 'DRAW', 'CANCELLED', 'NO_CONTEST');

-- CreateEnum
CREATE TYPE "TellerLedgerEntryType" AS ENUM ('CASH_ADVANCE', 'BET_PLACED', 'BET_VOIDED', 'BET_REFUNDED', 'PAYOUT', 'REMIT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('TELLER', 'ADMIN');

-- CreateTable
CREATE TABLE "Bet" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(8) NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "fightId" TEXT NOT NULL,
    "tellerId" TEXT NOT NULL,
    "tellerNameSnapshot" TEXT NOT NULL,
    "tellerInitialsSnapshot" VARCHAR(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "side" "BetSide" NOT NULL,
    "status" "BetStatus" NOT NULL DEFAULT 'PENDING',
    "payoutAmount" DECIMAL(14,2),
    "paidAt" TIMESTAMP(3),
    "paidByUserId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedByUserId" TEXT,
    "voidReason" TEXT,
    "previousStatus" "BetStatus",
    "previousPayoutAmount" DECIMAL(14,2),
    "correctedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Collector" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Collector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fight" (
    "id" TEXT NOT NULL,
    "fightNumber" INTEGER NOT NULL,
    "status" "FightStatus" NOT NULL DEFAULT 'SCHEDULED',
    "commissionRate" DECIMAL(5,4) NOT NULL,
    "meronPool" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "walaPool" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "meronAcceptingBets" BOOLEAN NOT NULL DEFAULT true,
    "meronHeldAt" TIMESTAMP(3),
    "meronHeldByUserId" TEXT,
    "walaAcceptingBets" BOOLEAN NOT NULL DEFAULT true,
    "walaHeldAt" TIMESTAMP(3),
    "walaHeldByUserId" TEXT,
    "outcome" "FightOutcome",
    "payoutRatioMeron" DECIMAL(10,4),
    "payoutRatioWala" DECIMAL(10,4),
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "previousOutcome" "FightOutcome",
    "previousPayoutRatioMeron" DECIMAL(10,4),
    "previousPayoutRatioWala" DECIMAL(10,4),
    "correctedAt" TIMESTAMP(3),
    "correctedByUserId" TEXT,
    "correctionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Fight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "commissionRate" DECIMAL(5,4) NOT NULL DEFAULT 0.10,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TellerLedger" (
    "id" TEXT NOT NULL,
    "tellerId" TEXT NOT NULL,
    "type" "TellerLedgerEntryType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "betId" TEXT,
    "collectorId" TEXT,
    "adjustedByUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TellerLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "initials" VARCHAR(3),
    "role" "UserRole" NOT NULL DEFAULT 'TELLER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Bet_code_key" ON "Bet"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Bet_clientRequestId_key" ON "Bet"("clientRequestId");

-- CreateIndex
CREATE INDEX "Bet_fightId_status_idx" ON "Bet"("fightId", "status");

-- CreateIndex
CREATE INDEX "Bet_tellerId_createdAt_idx" ON "Bet"("tellerId", "createdAt");

-- CreateIndex
CREATE INDEX "Bet_status_createdAt_idx" ON "Bet"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Bet_correctedAt_idx" ON "Bet"("correctedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Collector_name_key" ON "Collector"("name");

-- CreateIndex
CREATE INDEX "Collector_isActive_idx" ON "Collector"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Fight_fightNumber_key" ON "Fight"("fightNumber");

-- CreateIndex
CREATE INDEX "Fight_status_idx" ON "Fight"("status");

-- CreateIndex
CREATE INDEX "Fight_correctedAt_idx" ON "Fight"("correctedAt");

-- CreateIndex
CREATE INDEX "TellerLedger_tellerId_createdAt_idx" ON "TellerLedger"("tellerId", "createdAt");

-- CreateIndex
CREATE INDEX "TellerLedger_type_createdAt_idx" ON "TellerLedger"("type", "createdAt");

-- CreateIndex
CREATE INDEX "TellerLedger_betId_idx" ON "TellerLedger"("betId");

-- CreateIndex
CREATE INDEX "TellerLedger_collectorId_createdAt_idx" ON "TellerLedger"("collectorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_initials_key" ON "User"("initials");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

-- AddForeignKey
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_fightId_fkey" FOREIGN KEY ("fightId") REFERENCES "Fight"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_tellerId_fkey" FOREIGN KEY ("tellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_paidByUserId_fkey" FOREIGN KEY ("paidByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fight" ADD CONSTRAINT "Fight_correctedByUserId_fkey" FOREIGN KEY ("correctedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fight" ADD CONSTRAINT "Fight_meronHeldByUserId_fkey" FOREIGN KEY ("meronHeldByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fight" ADD CONSTRAINT "Fight_walaHeldByUserId_fkey" FOREIGN KEY ("walaHeldByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TellerLedger" ADD CONSTRAINT "TellerLedger_tellerId_fkey" FOREIGN KEY ("tellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TellerLedger" ADD CONSTRAINT "TellerLedger_betId_fkey" FOREIGN KEY ("betId") REFERENCES "Bet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TellerLedger" ADD CONSTRAINT "TellerLedger_collectorId_fkey" FOREIGN KEY ("collectorId") REFERENCES "Collector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TellerLedger" ADD CONSTRAINT "TellerLedger_adjustedByUserId_fkey" FOREIGN KEY ("adjustedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
