-- Draw/cancel refunds are paid at the payout desk, not auto-deducted at settlement.
ALTER TYPE "BetStatus" ADD VALUE 'PENDING_REFUND' BEFORE 'REFUNDED';
