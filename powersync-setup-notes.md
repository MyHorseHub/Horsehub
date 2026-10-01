# PowerSync Setup Notes

This prototype cannot perform cloud sync until a PowerSync Service instance exists. The SDK is the browser client; PowerSync Service provides the sync stream between PostgreSQL and the client SQLite database.

Current web SDK/package versions pinned by this prototype:
- @powersync/web 2.4.1
- @journeyapps/wa-sqlite 2.0.6
- @supabase/supabase-js 2.117.2

The client obtains the Supabase session and returns its access token to PowerSync as the sync credential. This follows the official PowerSync + Supabase demo pattern.
