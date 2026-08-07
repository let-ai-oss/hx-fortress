-- Cursor for the count-based completeness sweep.
--
-- The staleness gate selects a session only when its byte watermark is BEHIND
-- the canonical. That gate is blind to every failure that leaves the byte count
-- looking right: a record lost from the MIDDLE of a canonical (the lane stays
-- seq-dense and byte-covering), duplication (more turns than records), and a
-- watermark that was stamped with a size larger than what was actually indexed.
-- Such a session reads as healthy, is never selected, and so is never
-- re-examined by anything. On prod that is ~835 sessions carrying ~40,941
-- duplicate turns plus ~151 sessions that took a tail repair before the
-- watermark fix.
--
-- The only detector is the canonical's own record count, and obtaining it costs
-- one object read per session — far too expensive to do for the whole corpus on
-- every pass. So the sweep is incremental: each pass deep-verifies the least
-- recently verified rows and stamps them here. NULL sorts first, so a corpus
-- that has never been swept is worked through from the beginning and then
-- revisited on a slow rotation.
--
-- Deliberately NOT a boolean "verified" flag: a session can be verified today
-- and damaged tomorrow, so what matters is WHEN it was last proven, never that
-- it once was.
ALTER TABLE "hx"."sessions"
  ADD COLUMN IF NOT EXISTS "deep_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "hx"."session_agents"
  ADD COLUMN IF NOT EXISTS "deep_verified_at" timestamp with time zone;
--> statement-breakpoint
-- Partial indexes on the live rows only: the sweep always asks the same
-- question ("least recently verified, not deleted"), and the corpus of deleted
-- rows should never enter that ordering.
CREATE INDEX IF NOT EXISTS "hx_sessions_deep_verify_idx"
  ON "hx"."sessions" ("deep_verified_at" NULLS FIRST)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_session_agents_deep_verify_idx"
  ON "hx"."session_agents" ("deep_verified_at" NULLS FIRST)
  WHERE "deleted_at" IS NULL;
