CREATE FUNCTION clinical_instant_ms(v jsonb) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS $instant$
DECLARE
  n numeric;
  s text;
  parts text[];
  epoch_days integer;
  offset_minutes integer := 0;
BEGIN
  IF jsonb_typeof(v) = 'number' THEN
    n := (v #>> '{}')::numeric;
    IF n = trunc(n) AND abs(n) <= 8640000000000000 THEN RETURN n::bigint; END IF;
    RETURN NULL;
  END IF;
  IF jsonb_typeof(v) <> 'string' THEN RETURN NULL; END IF;
  s := v #>> '{}';
  IF length(s) NOT BETWEEN 20 AND 29 THEN RETURN NULL; END IF;
  parts := regexp_match(s COLLATE "C",
    '^([0-9]{4})-([0-9]{2})-([0-9]{2})T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(?:[.]([0-9]{1,3}))?(?:Z|([+-])([01][0-9]|2[0-3]):([0-5][0-9]))$');
  IF parts IS NULL OR parts[1] = '0000' THEN RETURN NULL; END IF;
  BEGIN
    epoch_days := make_date(parts[1]::int, parts[2]::int, parts[3]::int) - DATE '1970-01-01';
  EXCEPTION WHEN datetime_field_overflow THEN RETURN NULL;
  END;
  IF parts[8] IS NOT NULL THEN
    offset_minutes := (parts[9]::int * 60 + parts[10]::int)
      * CASE parts[8] WHEN '-' THEN -1 ELSE 1 END;
  END IF;
  RETURN epoch_days::bigint * 86400000
    + (parts[4]::int * 60 + parts[5]::int - offset_minutes) * 60000
    + parts[6]::int * 1000 + rpad(coalesce(parts[7], ''), 3, '0')::int;
END
$instant$
