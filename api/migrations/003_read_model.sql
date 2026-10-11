-- Claims read model (CQRS query side), kept current by the projector.
CREATE TABLE claim_view (
  claim_id           uuid PRIMARY KEY,
  claim_number       text NOT NULL,
  dealer_id          integer NOT NULL,
  dealer_name        text NOT NULL,
  vin                text NOT NULL,
  model              text NOT NULL,
  complaint          text NOT NULL,
  status             text NOT NULL,
  filed_at           timestamptz NOT NULL,
  version            integer NOT NULL,
  root_cause_code    text,
  confidence         double precision,
  warranty_decision  text,
  historical         boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- Keyset pagination: newest first, id breaks ties.
CREATE INDEX claim_view_keyset ON claim_view (filed_at DESC, claim_id DESC);
CREATE INDEX claim_view_dealer_keyset ON claim_view (dealer_id, filed_at DESC, claim_id DESC);
CREATE INDEX claim_view_status_keyset ON claim_view (status, filed_at DESC, claim_id DESC);
