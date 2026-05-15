-- Drop User.initials. The 3-char teller stamp is now derived at runtime from
-- the first three characters of User.username (see src/lib/initials.js).
--
-- Note: Bet.tellerInitialsSnapshot rows are NOT affected by this migration —
-- they are historical snapshots stored on each Bet, and they remain valid
-- for redemption and reporting of bets placed before this change.

-- DropIndex
DROP INDEX IF EXISTS "User_initials_key";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "initials";
