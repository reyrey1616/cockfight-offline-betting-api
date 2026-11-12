-- Super-admin switch: whether the admin dashboard lists unpaid winning tickets.
ALTER TABLE "Setting" ADD COLUMN "showUnpaidWinningTickets" BOOLEAN NOT NULL DEFAULT true;
