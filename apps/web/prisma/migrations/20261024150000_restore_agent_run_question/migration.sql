-- Restore the retained Prisma model without replacing an existing installation.
DO $migration$
DECLARE
  question_table regclass := to_regclass('public."AgentRunQuestion"');
  user_table regclass := to_regclass('public."User"');
  id_att smallint;
  user_id_att smallint;
  run_id_att smallint;
  user_pk_att smallint;
BEGIN
  IF user_table IS NULL THEN
    RAISE EXCEPTION 'AgentRunQuestion cannot be restored because public."User" is missing';
  END IF;

  IF question_table IS NULL THEN
    CREATE TABLE public."AgentRunQuestion" (
      "id" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "runId" TEXT NOT NULL,
      "stage" TEXT NOT NULL,
      "question" TEXT NOT NULL,
      "options" JSONB NOT NULL,
      "answer" TEXT,
      "autonomous" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "answeredAt" TIMESTAMP(3),
      CONSTRAINT "AgentRunQuestion_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "AgentRunQuestion_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES public."User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX "AgentRunQuestion_userId_runId_idx"
      ON public."AgentRunQuestion" USING btree ("userId", "runId");
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid = question_table AND relkind = 'r' AND relpersistence = 'p'
    ) THEN
      RAISE EXCEPTION 'AgentRunQuestion existing schema is incompatible';
    END IF;

    IF (SELECT count(*) FROM pg_attribute
        WHERE attrelid = question_table AND attnum > 0 AND NOT attisdropped) <> 10
      OR EXISTS (
        SELECT 1
        FROM (VALUES
          ('id', 'text', true, NULL::text),
          ('userId', 'text', true, NULL::text),
          ('runId', 'text', true, NULL::text),
          ('stage', 'text', true, NULL::text),
          ('question', 'text', true, NULL::text),
          ('options', 'jsonb', true, NULL::text),
          ('answer', 'text', false, NULL::text),
          ('autonomous', 'boolean', true, 'false'),
          ('createdAt', 'timestamp(3) without time zone', true, 'current_timestamp'),
          ('answeredAt', 'timestamp(3) without time zone', false, NULL::text)
        ) AS expected(name, formatted_type, is_not_null, default_expression)
        LEFT JOIN pg_attribute AS column_info
          ON column_info.attrelid = question_table
          AND column_info.attname = expected.name
          AND column_info.attnum > 0
          AND NOT column_info.attisdropped
        LEFT JOIN pg_attrdef AS column_default
          ON column_default.adrelid = column_info.attrelid
          AND column_default.adnum = column_info.attnum
        WHERE column_info.attnum IS NULL
          OR format_type(column_info.atttypid, column_info.atttypmod) IS DISTINCT FROM expected.formatted_type
          OR column_info.attnotnull IS DISTINCT FROM expected.is_not_null
          OR column_info.attgenerated IS DISTINCT FROM ''
          OR column_info.attidentity IS DISTINCT FROM ''
          OR (expected.default_expression IS NULL AND column_default.adbin IS NOT NULL)
          OR (expected.default_expression IS NOT NULL AND (
            column_default.adbin IS NULL
            OR lower(btrim(pg_get_expr(column_default.adbin, column_default.adrelid)))
              IS DISTINCT FROM expected.default_expression
          ))
      ) THEN
      RAISE EXCEPTION 'AgentRunQuestion existing schema is incompatible';
    END IF;

    SELECT attnum INTO id_att FROM pg_attribute
    WHERE attrelid = question_table AND attname = 'id' AND NOT attisdropped;
    SELECT attnum INTO user_id_att FROM pg_attribute
    WHERE attrelid = question_table AND attname = 'userId' AND NOT attisdropped;
    SELECT attnum INTO run_id_att FROM pg_attribute
    WHERE attrelid = question_table AND attname = 'runId' AND NOT attisdropped;
    SELECT attnum INTO user_pk_att FROM pg_attribute
    WHERE attrelid = user_table AND attname = 'id' AND NOT attisdropped;

    IF (SELECT count(*) FROM pg_constraint
        WHERE conrelid = question_table AND contype = 'p') <> 1
      OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = question_table AND contype = 'p'
          AND conname = 'AgentRunQuestion_pkey'
          AND conkey = ARRAY[id_att]::smallint[]
          AND convalidated AND NOT condeferrable AND NOT condeferred
      ) THEN
      RAISE EXCEPTION 'AgentRunQuestion existing schema is incompatible';
    END IF;

    IF (SELECT count(*) FROM pg_constraint
        WHERE conrelid = question_table AND contype = 'f') <> 1
      OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = question_table AND contype = 'f'
          AND conname = 'AgentRunQuestion_userId_fkey'
          AND conkey = ARRAY[user_id_att]::smallint[]
          AND confrelid = user_table
          AND confkey = ARRAY[user_pk_att]::smallint[]
          AND confdeltype = 'c' AND confupdtype = 'c'
          AND confmatchtype = 's' AND convalidated
          AND NOT condeferrable AND NOT condeferred
      ) THEN
      RAISE EXCEPTION 'AgentRunQuestion existing schema is incompatible';
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_index
      WHERE indrelid = question_table AND indisunique AND NOT indisprimary
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_index AS question_index
      JOIN pg_class AS index_relation ON index_relation.oid = question_index.indexrelid
      JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
      WHERE question_index.indrelid = question_table
        AND index_relation.relname = 'AgentRunQuestion_userId_runId_idx'
        AND index_relation.relkind = 'i'
        AND access_method.amname = 'btree'
        AND question_index.indisvalid AND question_index.indisready AND question_index.indislive
        AND NOT question_index.indisunique AND NOT question_index.indisprimary
        AND NOT question_index.indisexclusion
        AND question_index.indnkeyatts = 2 AND question_index.indnatts = 2
        AND question_index.indexprs IS NULL AND question_index.indpred IS NULL
        AND question_index.indkey::text = format('%s %s', user_id_att, run_id_att)
        AND question_index.indoption::text = '0 0'
    ) THEN
      RAISE EXCEPTION 'AgentRunQuestion existing schema is incompatible';
    END IF;
  END IF;
END
$migration$;
