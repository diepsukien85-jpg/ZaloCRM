-- LY VÂN AI CONTENT STUDIO — schema v1
-- Quy ước: mọi bảng nghiệp vụ có workspace_id (cách ly dữ liệu), created_at, updated_at.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

-- ===== Người dùng & workspace =====
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_chk CHECK (position('@' in email) > 1)
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  currency text NOT NULL DEFAULT 'VND',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'editor' CHECK (role IN ('owner','admin','editor','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

-- ===== Thương hiệu & DNA =====
CREATE TABLE brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  kind text NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal','business')),
  website text,
  description text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

CREATE TABLE brand_dna (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id)
);

CREATE TABLE brand_dna_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  version integer NOT NULL,
  data jsonb NOT NULL,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, version)
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text,
  description text NOT NULL DEFAULT '',
  url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, name)
);

CREATE TABLE audience_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  pain_points text[] NOT NULL DEFAULT '{}',
  desires text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, name)
);

CREATE TABLE content_pillars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name text NOT NULL,
  weight numeric(5,2) NOT NULL DEFAULT 0 CHECK (weight >= 0 AND weight <= 100),
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, name)
);

-- ===== Kênh =====
CREATE TABLE channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id uuid REFERENCES brands(id) ON DELETE SET NULL,
  name text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('facebook_profile','facebook_page','facebook_reels','tiktok','youtube','youtube_shorts','other')),
  url text,
  avatar_url text,
  target_audience text NOT NULL DEFAULT '',
  content_pillars text[] NOT NULL DEFAULT '{}',
  kpi jsonb NOT NULL DEFAULT '{}'::jsonb,
  connection_status text NOT NULL DEFAULT 'not_connected' CHECK (connection_status IN ('not_connected','manual','connected','error')),
  credentials_ref text,
  last_sync_at timestamptz,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_satellite boolean NOT NULL DEFAULT false,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
CREATE INDEX channels_brand_idx ON channels (brand_id);

CREATE TABLE channel_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'not_connected',
  scopes text[] NOT NULL DEFAULT '{}',
  encrypted_tokens text,
  expires_at timestamptz,
  last_error text,
  last_tested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, channel_id)
);

-- ===== Nghiên cứu: từ khoá, xu hướng =====
CREATE TABLE keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id uuid REFERENCES brands(id) ON DELETE SET NULL,
  keyword text NOT NULL,
  parent_keyword_id uuid REFERENCES keywords(id) ON DELETE SET NULL,
  language text NOT NULL DEFAULT 'vi' CHECK (language IN ('vi','en','zh')),
  category text NOT NULL DEFAULT '',
  search_intent text NOT NULL DEFAULT 'informational' CHECK (search_intent IN ('informational','navigational','commercial','transactional')),
  audience text NOT NULL DEFAULT '',
  funnel_stage text NOT NULL DEFAULT 'awareness' CHECK (funnel_stage IN ('awareness','consideration','decision','retention')),
  tier smallint NOT NULL DEFAULT 1 CHECK (tier BETWEEN 1 AND 5),
  relevance_score smallint CHECK (relevance_score BETWEEN 0 AND 100),
  content_potential_score smallint CHECK (content_potential_score BETWEEN 0 AND 100),
  scores_are_ai_estimate boolean NOT NULL DEFAULT true,
  search_volume integer CHECK (search_volume >= 0),
  search_volume_source text,
  source text NOT NULL DEFAULT 'manual',
  favorite boolean NOT NULL DEFAULT false,
  labels text[] NOT NULL DEFAULT '{}',
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT keywords_volume_needs_source CHECK (search_volume IS NULL OR search_volume_source IS NOT NULL)
);
CREATE UNIQUE INDEX keywords_uq ON keywords (workspace_id, lower(keyword), language);
CREATE INDEX keywords_ws_idx ON keywords (workspace_id, tier);
CREATE INDEX keywords_parent_idx ON keywords (parent_keyword_id);

CREATE TABLE keyword_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_keyword_id uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  to_keyword_id uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  relation text NOT NULL DEFAULT 'related',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_keyword_id, to_keyword_id, relation)
);

CREATE TABLE trend_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  platform text NOT NULL,
  kind text NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','api')),
  url text,
  status text NOT NULL DEFAULT 'not_connected',
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE trends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id uuid REFERENCES trend_sources(id) ON DELETE SET NULL,
  title text NOT NULL,
  platform text NOT NULL DEFAULT 'other',
  url text,
  country text,
  language text,
  published_at date,
  collected_at timestamptz NOT NULL DEFAULT now(),
  keywords text[] NOT NULL DEFAULT '{}',
  reason text NOT NULL DEFAULT '',
  relevance_score smallint CHECK (relevance_score BETWEEN 0 AND 100),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  reliability text NOT NULL DEFAULT 'unverified',
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','verified','rejected')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','saved','ignored')),
  analysis text NOT NULL DEFAULT '',
  application_hint text NOT NULL DEFAULT '',
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trends_ws_idx ON trends (workspace_id, status, collected_at DESC);

CREATE TABLE source_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  title text NOT NULL,
  url text,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX source_references_entity_idx ON source_references (workspace_id, entity_type, entity_id);

CREATE TABLE research_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  kind text NOT NULL DEFAULT 'general',
  body jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_run_id uuid,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE viral_decodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id uuid REFERENCES brands(id) ON DELETE SET NULL,
  title text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('url','transcript','post_text','screenshot_note')),
  source_url text,
  input_text text NOT NULL DEFAULT '',
  observed_visuals boolean NOT NULL DEFAULT false,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ===== Nhật ký, câu chuyện, ý tưởng =====
CREATE TABLE daily_journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id uuid REFERENCES brands(id) ON DELETE SET NULL,
  entry_date date NOT NULL DEFAULT current_date,
  title text NOT NULL DEFAULT '',
  body text NOT NULL,
  source_type text NOT NULL DEFAULT 'text' CHECK (source_type IN ('text','audio','video','image','chat','lesson','customer_case')),
  privacy text NOT NULL DEFAULT 'private' CHECK (privacy IN ('private','internal','public')),
  tags text[] NOT NULL DEFAULT '{}',
  media_asset_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX daily_journals_ws_idx ON daily_journals (workspace_id, entry_date DESC);
CREATE INDEX daily_journals_fts_idx ON daily_journals USING gin (to_tsvector('simple', coalesce(title,'') || ' ' || body));

CREATE TABLE stories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  journal_id uuid REFERENCES daily_journals(id) ON DELETE SET NULL,
  brand_id uuid REFERENCES brands(id) ON DELETE SET NULL,
  title text NOT NULL,
  extracted jsonb NOT NULL DEFAULT '{}'::jsonb,
  lessons text[] NOT NULL DEFAULT '{}',
  suggestions jsonb NOT NULL DEFAULT '{}'::jsonb,
  privacy text NOT NULL DEFAULT 'private' CHECK (privacy IN ('private','internal','public')),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stories_ws_idx ON stories (workspace_id, created_at DESC);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id uuid REFERENCES brands(id) ON DELETE SET NULL,
  name text NOT NULL,
  goal text NOT NULL DEFAULT '',
  start_date date,
  end_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','done','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE ideas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id uuid REFERENCES brands(id) ON DELETE SET NULL,
  keyword_id uuid REFERENCES keywords(id) ON DELETE SET NULL,
  story_id uuid REFERENCES stories(id) ON DELETE SET NULL,
  trend_id uuid REFERENCES trends(id) ON DELETE SET NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  pillar text NOT NULL DEFAULT '',
  format text NOT NULL DEFAULT 'post' CHECK (format IN ('post','short_video','long_video','carousel','infographic')),
  platform text NOT NULL DEFAULT 'facebook_profile',
  hook text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','selected','in_production','rejected','archived')),
  total_score smallint,
  fingerprint text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  workflow_run_id uuid,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ideas_ws_idx ON ideas (workspace_id, status, total_score DESC);
CREATE INDEX ideas_fp_idx ON ideas (workspace_id, fingerprint);

CREATE TABLE idea_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  attraction smallint NOT NULL CHECK (attraction BETWEEN 0 AND 25),
  brand_fit smallint NOT NULL CHECK (brand_fit BETWEEN 0 AND 25),
  retention smallint NOT NULL CHECK (retention BETWEEN 0 AND 20),
  conversion smallint NOT NULL CHECK (conversion BETWEEN 0 AND 20),
  feasibility smallint NOT NULL CHECK (feasibility BETWEEN 0 AND 10),
  total smallint NOT NULL CHECK (total BETWEEN 0 AND 100),
  rationale text NOT NULL DEFAULT '',
  is_ai_estimate boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idea_id)
);

-- ===== Nội dung =====
CREATE TABLE contents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id uuid REFERENCES brands(id) ON DELETE SET NULL,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  idea_id uuid REFERENCES ideas(id) ON DELETE SET NULL,
  story_id uuid REFERENCES stories(id) ON DELETE SET NULL,
  parent_content_id uuid REFERENCES contents(id) ON DELETE SET NULL,
  title text NOT NULL,
  content_type text NOT NULL DEFAULT 'post' CHECK (content_type IN ('post','video_script','carousel','infographic','youtube_description')),
  format text NOT NULL DEFAULT 'text',
  platform text NOT NULL DEFAULT 'facebook_profile',
  pillar text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('idea','researching','writing','draft','pending_review','changes_requested','approved','in_production','ready_to_publish','scheduled','published','failed','archived')),
  body text NOT NULL DEFAULT '',
  hooks text[] NOT NULL DEFAULT '{}',
  caption text NOT NULL DEFAULT '',
  hashtags text[] NOT NULL DEFAULT '{}',
  cta text NOT NULL DEFAULT '',
  keyword_ids uuid[] NOT NULL DEFAULT '{}',
  references_text text NOT NULL DEFAULT '',
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  scheduled_at timestamptz,
  published_at timestamptz,
  privacy text NOT NULL DEFAULT 'internal' CHECK (privacy IN ('private','internal','public')),
  current_version integer NOT NULL DEFAULT 1,
  ai_generated boolean NOT NULL DEFAULT false,
  is_demo boolean NOT NULL DEFAULT false,
  workflow_run_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contents_ws_status_idx ON contents (workspace_id, status);
CREATE INDEX contents_sched_idx ON contents (workspace_id, scheduled_at);
CREATE INDEX contents_parent_idx ON contents (parent_content_id);

CREATE TABLE content_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_id uuid NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  hooks text[] NOT NULL DEFAULT '{}',
  caption text NOT NULL DEFAULT '',
  change_note text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','autosave','ai_generate','ai_rewrite','restore')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_id, version)
);

CREATE TABLE content_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_id uuid NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('facebook_profile','facebook_page','facebook_reels','tiktok','youtube_shorts','youtube_long')),
  title text NOT NULL DEFAULT '',
  hook text NOT NULL DEFAULT '',
  caption text NOT NULL DEFAULT '',
  hashtags text[] NOT NULL DEFAULT '{}',
  aspect_ratio text NOT NULL DEFAULT '',
  duration_sec integer,
  cta text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_id, platform)
);

CREATE TABLE content_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_id uuid NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('request_review','approve','request_changes','publish_confirm','reschedule_confirm')),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_approvals_idx ON content_approvals (content_id, created_at DESC);

-- ===== Video =====
CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image','video','audio','document','logo','other')),
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  storage_path text NOT NULL,
  privacy text NOT NULL DEFAULT 'internal' CHECK (privacy IN ('private','internal','public')),
  transcript text,
  tags text[] NOT NULL DEFAULT '{}',
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_assets_ws_idx ON media_assets (workspace_id, created_at DESC);

CREATE TABLE characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id uuid REFERENCES brands(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'character' CHECK (kind IN ('character','product','location','logo','voice','outfit')),
  name text NOT NULL,
  tag text,
  description text NOT NULL DEFAULT '',
  reference_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  consent_confirmed boolean NOT NULL DEFAULT false,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, name)
);

CREATE TABLE video_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id uuid REFERENCES brands(id) ON DELETE SET NULL,
  content_id uuid REFERENCES contents(id) ON DELETE SET NULL,
  title text NOT NULL,
  duration_sec integer NOT NULL DEFAULT 30,
  aspect_ratio text NOT NULL DEFAULT '9:16',
  status text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','scripted','in_production','done','archived')),
  script jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text NOT NULL DEFAULT '',
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX video_projects_ws_idx ON video_projects (workspace_id, created_at DESC);

CREATE TABLE video_scenes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
  scene_no integer NOT NULL CHECK (scene_no > 0),
  duration_sec integer NOT NULL DEFAULT 8 CHECK (duration_sec BETWEEN 1 AND 60),
  reference_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
  shot_description text NOT NULL DEFAULT '',
  dialogue text NOT NULL DEFAULT '',
  voiceover text NOT NULL DEFAULT '',
  camera text NOT NULL DEFAULT '',
  lighting text NOT NULL DEFAULT '',
  audio text NOT NULL DEFAULT '',
  on_screen_text text NOT NULL DEFAULT '',
  environment text NOT NULL DEFAULT '',
  outfit text NOT NULL DEFAULT '',
  prompt text NOT NULL DEFAULT '',
  generated_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  approval_status text NOT NULL DEFAULT 'draft' CHECK (approval_status IN ('draft','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX video_scenes_project_idx ON video_scenes (project_id, scene_no);

-- ===== Lịch & phân phối =====
CREATE TABLE schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_id uuid NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  platform text NOT NULL DEFAULT 'facebook_profile',
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','confirmed','done','cancelled')),
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedules_ws_idx ON schedules (workspace_id, scheduled_at);
CREATE UNIQUE INDEX schedules_active_uq ON schedules (content_id, platform) WHERE status IN ('planned','confirmed');

CREATE TABLE publication_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  schedule_id uuid REFERENCES schedules(id) ON DELETE SET NULL,
  content_id uuid NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  mode text NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual','api')),
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','ready','published_manual','published','failed','cancelled')),
  attempt integer NOT NULL DEFAULT 0,
  error text,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key text,
  external_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX publication_jobs_idem_uq ON publication_jobs (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE publication_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES publication_jobs(id) ON DELETE CASCADE,
  level text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ===== Analytics, lead, doanh thu =====
CREATE TABLE analytics_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_id uuid REFERENCES contents(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  platform text NOT NULL DEFAULT 'other',
  snapshot_date date NOT NULL DEFAULT current_date,
  views bigint NOT NULL DEFAULT 0 CHECK (views >= 0),
  reach bigint NOT NULL DEFAULT 0 CHECK (reach >= 0),
  watch_time_sec bigint NOT NULL DEFAULT 0 CHECK (watch_time_sec >= 0),
  avg_view_duration_sec numeric(10,2) NOT NULL DEFAULT 0,
  completion_rate numeric(5,2) NOT NULL DEFAULT 0 CHECK (completion_rate BETWEEN 0 AND 100),
  likes bigint NOT NULL DEFAULT 0 CHECK (likes >= 0),
  comments bigint NOT NULL DEFAULT 0 CHECK (comments >= 0),
  shares bigint NOT NULL DEFAULT 0 CHECK (shares >= 0),
  saves bigint NOT NULL DEFAULT 0 CHECK (saves >= 0),
  followers_gained bigint NOT NULL DEFAULT 0,
  leads integer NOT NULL DEFAULT 0 CHECK (leads >= 0),
  quotes integer NOT NULL DEFAULT 0 CHECK (quotes >= 0),
  orders integer NOT NULL DEFAULT 0 CHECK (orders >= 0),
  revenue numeric(16,2) NOT NULL DEFAULT 0 CHECK (revenue >= 0),
  gross_profit numeric(16,2) NOT NULL DEFAULT 0,
  ad_spend numeric(16,2) NOT NULL DEFAULT 0 CHECK (ad_spend >= 0),
  data_source text NOT NULL DEFAULT 'manual' CHECK (data_source IN ('manual','csv','api')),
  attribution_method text NOT NULL DEFAULT 'manual',
  notes text NOT NULL DEFAULT '',
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_ws_idx ON analytics_snapshots (workspace_id, snapshot_date DESC);
CREATE INDEX analytics_content_idx ON analytics_snapshots (content_id);

CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  contact text NOT NULL DEFAULT '',
  contact_consent boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'manual',
  platform text,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  content_id uuid REFERENCES contents(id) ON DELETE SET NULL,
  need text NOT NULL DEFAULT '',
  product_interest text NOT NULL DEFAULT '',
  budget numeric(16,2),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','qualified','quoted','negotiating','won','lost')),
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  quote_amount numeric(16,2),
  order_count integer NOT NULL DEFAULT 0,
  revenue numeric(16,2) NOT NULL DEFAULT 0,
  gross_profit numeric(16,2) NOT NULL DEFAULT 0,
  notes text NOT NULL DEFAULT '',
  external_ref text,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_ws_idx ON leads (workspace_id, status);
CREATE UNIQUE INDEX leads_ext_uq ON leads (workspace_id, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE sales_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  content_id uuid REFERENCES contents(id) ON DELETE SET NULL,
  method text NOT NULL DEFAULT 'manual' CHECK (method IN ('manual','first_touch','last_touch')),
  revenue numeric(16,2) NOT NULL DEFAULT 0,
  gross_profit numeric(16,2) NOT NULL DEFAULT 0,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ===== AI: agent, prompt, workflow, chi phí =====
CREATE TABLE agent_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  provider text,
  model text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, agent_key)
);

CREATE TABLE prompt_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, agent_key, name)
);

CREATE TABLE prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
  version integer NOT NULL,
  system_prompt text NOT NULL,
  user_prompt text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT false,
  notes text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

CREATE TABLE workflow_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  implemented boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, key)
);

CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  trigger text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','schedule')),
  idempotency_key text,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  attempt integer NOT NULL DEFAULT 1,
  budget_limit_usd numeric(12,4),
  cancel_requested boolean NOT NULL DEFAULT false,
  is_demo boolean NOT NULL DEFAULT false,
  triggered_by uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_runs_ws_idx ON workflow_runs (workspace_id, created_at DESC);
CREATE UNIQUE INDEX workflow_runs_idem_uq ON workflow_runs (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL AND status <> 'failed' AND status <> 'cancelled';

CREATE TABLE workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_no integer NOT NULL,
  key text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  output_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_no)
);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_run_id uuid REFERENCES workflow_runs(id) ON DELETE SET NULL,
  agent_key text NOT NULL,
  task text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  provider text,
  model text,
  prompt_version integer,
  cache_hit boolean NOT NULL DEFAULT false,
  is_demo boolean NOT NULL DEFAULT false,
  error text,
  duration_ms integer,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_runs_ws_idx ON agent_runs (workspace_id, created_at DESC);

CREATE TABLE automation_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  hour smallint NOT NULL DEFAULT 7 CHECK (hour BETWEEN 0 AND 23),
  minute smallint NOT NULL DEFAULT 0 CHECK (minute BETWEEN 0 AND 59),
  weekday smallint CHECK (weekday BETWEEN 0 AND 6),
  day_of_month smallint CHECK (day_of_month BETWEEN 1 AND 28),
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  budget_limit_usd numeric(12,4),
  last_run_at timestamptz,
  next_run_at timestamptz,
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, workflow_key)
);

CREATE TABLE ai_usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  agent_key text,
  task text,
  workflow_run_id uuid REFERENCES workflow_runs(id) ON DELETE SET NULL,
  agent_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  est_cost_usd numeric(14,6) NOT NULL DEFAULT 0,
  actual_cost_usd numeric(14,6),
  status text NOT NULL DEFAULT 'ok',
  error text,
  cache_hit boolean NOT NULL DEFAULT false,
  is_demo boolean NOT NULL DEFAULT false,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_ws_idx ON ai_usage_logs (workspace_id, created_at DESC);

CREATE TABLE budget_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('daily','monthly')),
  amount_usd numeric(12,4) NOT NULL CHECK (amount_usd >= 0),
  warn_pct smallint NOT NULL DEFAULT 80 CHECK (warn_pct BETWEEN 1 AND 100),
  hard_stop boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, scope)
);

CREATE TABLE ai_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cache_key text NOT NULL,
  task text NOT NULL,
  response jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, cache_key)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'info',
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_ws_idx ON notifications (workspace_id, read_at, created_at DESC);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_ws_idx ON audit_logs (workspace_id, created_at DESC);

CREATE TABLE app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, key)
);

CREATE TABLE rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 1,
  PRIMARY KEY (bucket, window_start)
);

-- ===== Trigger updated_at cho mọi bảng có cột updated_at =====
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'updated_at' LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                   'trg_' || t.table_name || '_updated', t.table_name);
  END LOOP;
END $$;
