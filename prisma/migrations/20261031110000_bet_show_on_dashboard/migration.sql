-- Per-ticket switch: unpaid winning tickets hidden here are omitted from the admin dashboard.
ALTER TABLE "Bet" ADD COLUMN "showOnDashboard" BOOLEAN NOT NULL DEFAULT true;
