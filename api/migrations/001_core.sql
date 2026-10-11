-- Dealers, vehicles, API keys and the claims write model.
CREATE TABLE dealers (
  id      integer PRIMARY KEY,
  name    text NOT NULL UNIQUE,
  region  text NOT NULL
);

CREATE TABLE vehicles (
  vin          text PRIMARY KEY CHECK (length(vin) = 17),
  model        text NOT NULL,
  dealer_id    integer NOT NULL REFERENCES dealers (id),
  sale_date    date NOT NULL,
  odometer_km  integer NOT NULL CHECK (odometer_km >= 0)
);

CREATE TABLE api_keys (
  id                   text PRIMARY KEY,
  label                text NOT NULL,
  key_hash             text NOT NULL UNIQUE,
  scopes               text[] NOT NULL,
  dealer_id            integer REFERENCES dealers (id),
  rate_capacity        integer NOT NULL,
  rate_refill_per_sec  double precision NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE claim_number_seq START 1;

CREATE TABLE claims (
  id            uuid PRIMARY KEY,
  claim_number  text NOT NULL UNIQUE,
  dealer_id     integer NOT NULL REFERENCES dealers (id),
  vin           text NOT NULL REFERENCES vehicles (vin),
  complaint     text NOT NULL,
  odometer_km   integer NOT NULL,
  status        text NOT NULL CHECK (status IN ('filed', 'triaging', 'awaiting_review', 'approved', 'rejected', 'dead_lettered')),
  filed_at      timestamptz NOT NULL,
  trace_id      text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  created_by    text
);

CREATE TABLE ride_logs (
  claim_id  uuid PRIMARY KEY REFERENCES claims (id),
  ride_log  jsonb NOT NULL,
  rows      integer NOT NULL
);

CREATE TABLE idempotency_records (
  api_key_id     text NOT NULL REFERENCES api_keys (id),
  idem_key       text NOT NULL,
  request_hash   text NOT NULL,
  status_code    integer NOT NULL,
  response_body  jsonb NOT NULL,
  claim_id       uuid REFERENCES claims (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, idem_key)
);
