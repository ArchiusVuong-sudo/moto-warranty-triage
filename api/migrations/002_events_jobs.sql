-- Transactional outbox, consumer inbox, leased job queue and the trace timeline.
CREATE TABLE events (
  seq           bigserial PRIMARY KEY,
  id            uuid NOT NULL UNIQUE,
  aggregate_id  uuid NOT NULL,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  trace_id      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX events_unpublished ON events (seq) WHERE published_at IS NULL;

CREATE TABLE processed_events (
  consumer      text NOT NULL,
  event_id      uuid NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE jobs (
  id               uuid PRIMARY KEY,
  claim_id         uuid NOT NULL REFERENCES claims (id),
  kind             text NOT NULL,
  status           text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL,
  next_run_at      timestamptz NOT NULL DEFAULT now(),
  lease_owner      text,
  lease_until      timestamptz,
  idempotency_key  text NOT NULL UNIQUE,
  trace_id         text NOT NULL,
  last_error       text,
  dead_reason      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready ON jobs (next_run_at) WHERE status IN ('queued', 'running');
CREATE INDEX jobs_claim ON jobs (claim_id);

CREATE TABLE job_attempts (
  job_id             uuid NOT NULL REFERENCES jobs (id),
  n                  integer NOT NULL,
  started_at         timestamptz NOT NULL,
  ended_at           timestamptz,
  outcome            text,
  error              text,
  served_from_store  boolean,
  PRIMARY KEY (job_id, n)
);

CREATE TABLE triage_results (
  claim_id    uuid PRIMARY KEY REFERENCES claims (id),
  job_id      uuid NOT NULL REFERENCES jobs (id),
  result      jsonb NOT NULL,
  run         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE triage_decisions (
  claim_id      uuid PRIMARY KEY REFERENCES claims (id),
  decision      text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  suggested     jsonb NOT NULL,
  final         jsonb,
  edits         jsonb NOT NULL,
  note          text,
  decided_by    text NOT NULL,
  decided_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per step under a claim's trace id: events, jobs, attempts, tool spans, drills.
CREATE TABLE spans (
  id           bigserial PRIMARY KEY,
  claim_id     uuid NOT NULL,
  trace_id     text NOT NULL,
  kind         text NOT NULL,
  name         text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  duration_ms  double precision,
  attempt      integer,
  status       text NOT NULL DEFAULT 'ok',
  attrs        jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX spans_claim ON spans (claim_id, id);
