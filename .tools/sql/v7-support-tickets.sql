-- v7-support-tickets.sql —— 注销后删除云端记录的页内工单（2026-11-05）
-- ⚠️ 待平台执行：本次 PR 不执行任何 SQL。执行位置 = WorkBuddy「应用数据库」控制台（service role）。
-- 读取路径按方案 A：用户只读自己那行；客服在控制台用 service role 读全表。
-- RLS 铁律：authenticated 只能 INSERT / SELECT 自己的行（owner_id = auth.uid()）；不给 UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER。
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_no text NOT NULL UNIQUE,
  owner_id text NOT NULL DEFAULT auth.uid(),
  request_type text NOT NULL DEFAULT 'delete_cloud_records' CHECK (request_type IN ('delete_cloud_records')),
  user_ref text NOT NULL DEFAULT '',
  local_deleted_at timestamptz,
  record_kinds text[] NOT NULL DEFAULT '{}' CHECK (record_kinds <@ ARRAY['llm_events','feedback','client_errors']::text[]),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  contact text NOT NULL DEFAULT '' CHECK (char_length(contact) <= 80),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','processing','done','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.support_tickets FROM anon, PUBLIC;
GRANT INSERT, SELECT ON TABLE public.support_tickets TO authenticated;
GRANT ALL ON TABLE public.support_tickets TO service_role;

CREATE POLICY support_tickets_insert_own ON public.support_tickets
  FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());

CREATE POLICY support_tickets_select_own ON public.support_tickets
  FOR SELECT TO authenticated USING (owner_id = auth.uid());

CREATE INDEX IF NOT EXISTS support_tickets_owner_created_idx
  ON public.support_tickets (owner_id, created_at DESC);
