BEGIN;

GRANT USAGE ON SCHEMA public TO pendleton_runtime;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.conversation_sessions, public.conversation_turns
  TO pendleton_runtime;
GRANT USAGE, SELECT
  ON SEQUENCE public.conversation_turns_turn_sequence_seq
  TO pendleton_runtime;

ALTER TABLE public.conversation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_turns ENABLE ROW LEVEL SECURITY;

CREATE POLICY pendleton_runtime_access
  ON public.conversation_sessions
  FOR ALL
  TO pendleton_runtime
  USING (true)
  WITH CHECK (true);

CREATE POLICY pendleton_runtime_access
  ON public.conversation_turns
  FOR ALL
  TO pendleton_runtime
  USING (true)
  WITH CHECK (true);

REVOKE ALL
  ON TABLE public.conversation_sessions, public.conversation_turns
  FROM anon, authenticated;
REVOKE ALL
  ON SEQUENCE public.conversation_turns_turn_sequence_seq
  FROM anon, authenticated;

COMMIT;
