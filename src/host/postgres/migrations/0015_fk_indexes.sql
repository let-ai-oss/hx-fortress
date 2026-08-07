-- Covering indexes for the foreign keys that DELETE cascades through.
--
-- `hx.tool_calls.turn_id` references `hx.turns(id) ON DELETE CASCADE` and had no
-- index. Postgres enforces a cascade by looking up referencing rows PER DELETED
-- ROW, so an unindexed FK turns every `delete from hx.turns where session_id=$1`
-- into one sequential scan of hx.tool_calls (546 MB / 578k rows on prod) for
-- EACH deleted turn. A guarantor rebuild deleting ~2k turns therefore ran until
-- the 120 s statement_timeout killed it — every pass, forever, holding a
-- background connection the whole time. That starved the 2-connection pool and
-- failed ~80% of repair work with a 10 s acquire timeout.
--
-- The cascade cost is invisible in EXPLAIN (it is trigger work, not plan work):
-- the delete's own plan is a cheap Index Scan, which is why this hid so long.
--
-- `hx.turns.agent_id` -> `hx.session_agents` is the same trap on a 2.3 GB child,
-- reached when a session_agents row is deleted.
--
-- On an existing deployment these are built out-of-band with CREATE INDEX
-- CONCURRENTLY (no write lock) BEFORE this migration runs; IF NOT EXISTS then
-- makes this a no-op there. A migration cannot use CONCURRENTLY itself — the
-- runner wraps each batch in a transaction and CONCURRENTLY is forbidden inside
-- one. On a fresh/small database the plain build here is instant.
CREATE INDEX IF NOT EXISTS "hx_tool_calls_turn_id_idx"
  ON "hx"."tool_calls" ("turn_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_tool_calls_agent_id_idx"
  ON "hx"."tool_calls" ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_turns_agent_id_idx"
  ON "hx"."turns" ("agent_id");
--> statement-breakpoint
-- The remaining foreign keys in `hx`. These sit on small tables today, so none
-- of them is the outage above — but a half-enforced invariant is not an
-- invariant, and "small today" is not a property that holds. Covering all of
-- them lets the FK-index test assert an empty set, which is what actually stops
-- the next unindexed FK from reaching prod.
CREATE INDEX IF NOT EXISTS "hx_sessions_device_id_idx"
  ON "hx"."sessions" ("device_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_session_agents_model_id_idx"
  ON "hx"."session_agents" ("model_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_repos_project_id_idx"
  ON "hx"."repos" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_analysis_runs_definition_id_idx"
  ON "hx"."analysis_runs" ("definition_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_analysis_runs_model_id_idx"
  ON "hx"."analysis_runs" ("model_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_usage_rollup_user_id_idx"
  ON "hx"."usage_rollup" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_usage_rollup_project_id_idx"
  ON "hx"."usage_rollup" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hx_usage_rollup_model_id_idx"
  ON "hx"."usage_rollup" ("model_id");
