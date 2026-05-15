-- Passwords are stored as plaintext (application no longer uses bcrypt).
-- Rename column so the schema matches reality. Existing bcrypt hashes in
-- this column will NOT verify as logins until each user is re-seeded or
-- has their password reset via the API.
ALTER TABLE "User" RENAME COLUMN "passwordHash" TO "password";
