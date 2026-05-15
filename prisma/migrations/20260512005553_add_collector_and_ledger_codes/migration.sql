-- Add scannable barcode codes to Collector and TellerLedger.
--
--   Collector.code      → "COL" + 5 reduced-alphabet chars  (NOT NULL after backfill)
--   TellerLedger.code   → "ADV"/"REM" + 5 reduced-alphabet (NULL for non-cash rows)
--
-- The reduced alphabet ABCDEFGHJKMNPQRTUVWXY346789 (28 chars) excludes
-- look-alikes (0/O, 1/I/L, 5/S, 2/Z, etc.) so handwritten/thermal-printed
-- codes stay unambiguous when scanned or typed back. This MUST stay in
-- sync with src/lib/code-generator.js — both are the source of truth for
-- the same characters.
--
-- Backfill notes:
--   * Existing Collector rows: every row gets a COL... code.
--   * Existing TellerLedger rows: only CASH_ADVANCE → "ADV...", REMIT
--     → "REM...". All other types stay NULL (their printable code, if
--     any, lives on the related Bet row).
--   * Code generator runs in a per-row retry loop; the unique index is
--     created BEFORE the backfill so collisions surface immediately and
--     trigger the next attempt.

-- ===========================================================================
-- 1. Add the columns + unique indexes (multiple NULLs are allowed in
--    Postgres unique indexes by default, which is exactly what we want
--    while we backfill).
-- ===========================================================================

ALTER TABLE "Collector"    ADD COLUMN "code" TEXT;
ALTER TABLE "TellerLedger" ADD COLUMN "code" TEXT;

CREATE UNIQUE INDEX "Collector_code_key"    ON "Collector"("code");
CREATE UNIQUE INDEX "TellerLedger_code_key" ON "TellerLedger"("code");

-- ===========================================================================
-- 2. Backfill helper. Lives in the public schema for the duration of this
--    migration only; we DROP it at the end so it doesn't leak.
-- ===========================================================================

CREATE OR REPLACE FUNCTION _migration_gen_code(p_prefix TEXT)
RETURNS TEXT AS $$
DECLARE
  alpha TEXT := 'ABCDEFGHJKMNPQRTUVWXY346789';
  rand  TEXT := '';
  i     INT;
BEGIN
  FOR i IN 1..5 LOOP
    -- floor(random() * 28) gives 0..27; +1 because substr is 1-indexed.
    rand := rand || substr(alpha, 1 + floor(random() * length(alpha))::INT, 1);
  END LOOP;
  RETURN p_prefix || rand;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- 3. Backfill Collector codes. Per-row retry on unique_violation.
-- ===========================================================================

DO $$
DECLARE
  rec      RECORD;
  new_code TEXT;
  attempts INT;
BEGIN
  FOR rec IN SELECT id FROM "Collector" WHERE code IS NULL LOOP
    attempts := 0;
    LOOP
      attempts := attempts + 1;
      new_code := _migration_gen_code('COL');
      BEGIN
        UPDATE "Collector" SET code = new_code WHERE id = rec.id;
        EXIT;  -- success
      EXCEPTION WHEN unique_violation THEN
        IF attempts >= 8 THEN
          RAISE EXCEPTION
            'Could not generate unique Collector.code after 8 attempts (id=%)',
            rec.id;
        END IF;
        -- else loop and try again with a fresh random portion
      END;
    END LOOP;
  END LOOP;
END $$;

-- ===========================================================================
-- 4. Backfill TellerLedger codes for CASH_ADVANCE / REMIT only.
--    Other types stay NULL — they're either bet-derived (have a bet.code
--    via betId) or not user-printable (ADJUSTMENT, which is moot since
--    the app refuses to write any).
-- ===========================================================================

DO $$
DECLARE
  rec      RECORD;
  new_code TEXT;
  prefix   TEXT;
  attempts INT;
BEGIN
  FOR rec IN
    SELECT id, type
    FROM "TellerLedger"
    WHERE code IS NULL AND type IN ('CASH_ADVANCE', 'REMIT')
  LOOP
    prefix := CASE rec.type
                WHEN 'CASH_ADVANCE' THEN 'ADV'
                WHEN 'REMIT'        THEN 'REM'
              END;
    attempts := 0;
    LOOP
      attempts := attempts + 1;
      new_code := _migration_gen_code(prefix);
      BEGIN
        UPDATE "TellerLedger" SET code = new_code WHERE id = rec.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        IF attempts >= 8 THEN
          RAISE EXCEPTION
            'Could not generate unique TellerLedger.code after 8 attempts (id=%)',
            rec.id;
        END IF;
      END;
    END LOOP;
  END LOOP;
END $$;

-- ===========================================================================
-- 5. Tighten Collector.code to NOT NULL now that every row has one.
--    TellerLedger.code stays nullable on purpose (see comment in step 4).
-- ===========================================================================

ALTER TABLE "Collector" ALTER COLUMN "code" SET NOT NULL;

-- ===========================================================================
-- 6. Drop the helper function so it doesn't pollute the public schema.
-- ===========================================================================

DROP FUNCTION _migration_gen_code(TEXT);
