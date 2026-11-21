-- GENERATED FILE — do not edit.
--
-- PostgreSQL DDL for the Nightscout `entries` collection, multitenant shape.
--
-- Source:   aid-entries-2025.yaml
-- Evidence: reports/schema-census/entries.census.json
-- Indexes:  lib/server/entries.js:246 (indexedFields, on chore/nightscout-modernization)
-- Emitter:  tools/nsschema/emit/postgres_emit.py
--
-- Regenerate with: python -m tools.nsschema.emit.postgres_emit --identity-kinds --collection entries --out <output-directory>
-- Experimental identity codec required: id_kind is storage metadata, never a client field.
-- No migration/import or complete adapter acceptance is implied.
--
-- THE COLUMNS BELOW ARE AN INDEX ACCELERATOR. THE DOCUMENT IS THE RECORD.
-- Dropping every generated column must not change an answer. In particular an
-- `$exists` check must read `doc #> '{path}'` and never a column: a column is
-- built from `->>`, which returns SQL NULL for an absent key and for an explicit
-- JSON null alike, and cannot tell them apart. lib/storage/filter.js does this
-- correctly; nothing here licenses a hand-written query to do otherwise.
--
-- Indexed fields with no column, and why:
--   (none)

CREATE TABLE entries (
  -- tenant_id leads the table and every index below: under RLS the policy
  -- predicate is an ordinary equality, and the planner can only build index
  -- bounds from it if it is the leading column.
  tenant_id  uuid   NOT NULL,
  doc        jsonb  NOT NULL,
  id_kind text NOT NULL CHECK (id_kind IN ('objectid', 'string')),
  "_id"        text NOT NULL
    GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(doc #> '{_id}') = 'string' THEN (doc #>> '{_id}') END) STORED,
  "date"       numeric
    GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(doc #> '{date}') = 'number' THEN (doc #>> '{date}')::numeric END) STORED,
  "type"       text
    GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(doc #> '{type}') = 'string' THEN (doc #>> '{type}') END) STORED,
  "sgv"        numeric
    GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(doc #> '{sgv}') = 'number' THEN (doc #>> '{sgv}')::numeric END) STORED,
  "mbg"        numeric
    GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(doc #> '{mbg}') = 'number' THEN (doc #>> '{mbg}')::numeric END) STORED,
  "sysTime"    text
    GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(doc #> '{sysTime}') = 'string' THEN (doc #>> '{sysTime}') END) STORED,
  "dateString" text
    GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(doc #> '{dateString}') = 'string' THEN (doc #>> '{dateString}') END) STORED,
  "identifier" text
    GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(doc #> '{identifier}') = 'string' THEN (doc #>> '{identifier}') END) STORED,
  "created_at" text
    GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(doc #> '{created_at}') = 'string' THEN (doc #>> '{created_at}') END) STORED,

  -- Scoped to the tenant rather than global: two tenants restored from
  -- different deployments can legitimately carry the same _id, and a
  -- global unique constraint would make one of them unimportable.
  CHECK ("_id" <> ''),
  CHECK (id_kind <> 'objectid' OR "_id" ~ '^[0-9a-f]{24}$'),
  PRIMARY KEY (tenant_id, id_kind, "_id")
);

CREATE INDEX entries_tenant_date
  ON entries (tenant_id, "date" ASC);
CREATE INDEX entries_tenant_type
  ON entries (tenant_id, "type" ASC);
CREATE INDEX entries_tenant_sgv
  ON entries (tenant_id, "sgv" ASC);
CREATE INDEX entries_tenant_mbg
  ON entries (tenant_id, "mbg" ASC);
CREATE INDEX entries_tenant_systime
  ON entries (tenant_id, "sysTime" ASC);
CREATE INDEX entries_tenant_datestring
  ON entries (tenant_id, "dateString" ASC);
CREATE INDEX entries_tenant_identifier
  ON entries (tenant_id, "identifier" ASC);
CREATE INDEX entries_tenant_type_date_datestring
  ON entries (tenant_id, "type" ASC, "date" DESC, "dateString" ASC);
CREATE INDEX entries_tenant_date_identifier_created_at
  ON entries (tenant_id, "date" DESC, "identifier" DESC, "created_at" DESC);

-- FORCE is the load-bearing word: without it the table OWNER bypasses the
-- policy. It still does not subject a SUPERUSER — BYPASSRLS is implicit for
-- one — so anything verifying isolation must connect as a role that is
-- NOSUPERUSER NOBYPASSRLS, or it has verified nothing.
ALTER TABLE entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE entries FORCE ROW LEVEL SECURITY;

-- NULLIF so that an unbound connection yields NULL rather than an empty
-- string, and `tenant_id = NULL` is never true: the fail-closed property
-- D3 is chosen for. WITH CHECK is what extends it to writes, which is the
-- axis MongoDB's role-keyed views cannot cover at all ({M} §6.7).
CREATE POLICY entries_tenant_isolation ON entries
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
