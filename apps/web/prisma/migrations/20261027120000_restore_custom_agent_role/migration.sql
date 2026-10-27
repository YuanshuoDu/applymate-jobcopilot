-- Restore the retained Prisma model without replacing an existing installation.
DO $migration$
DECLARE
  role_table pg_catalog.regclass := pg_catalog.to_regclass('public."CustomAgentRole"');
  user_table pg_catalog.regclass := pg_catalog.to_regclass('public."User"');
  id_att pg_catalog.int2;
  user_id_att pg_catalog.int2;
  user_pk_att pg_catalog.int2;
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);

  IF user_table IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = user_table AND relkind = 'r' AND relpersistence = 'p'
  ) THEN
    RAISE EXCEPTION 'CustomAgentRole cannot be restored because public."User" is missing or incompatible';
  END IF;

  SELECT attnum INTO user_pk_att FROM pg_attribute
  WHERE attrelid = user_table AND attname = 'id' AND attnum > 0 AND NOT attisdropped
    AND format_type(atttypid, atttypmod) = 'text' AND attnotnull;

  IF user_pk_att IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = user_table AND contype = 'p' AND conname = 'User_pkey'
      AND conkey = ARRAY[user_pk_att]::smallint[]
      AND convalidated AND NOT condeferrable AND NOT condeferred
  ) THEN
    RAISE EXCEPTION 'CustomAgentRole cannot be restored because public."User"."id" is incompatible';
  END IF;

  IF role_table IS NULL THEN
    CREATE TABLE public."CustomAgentRole" (
      "id" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "icon" TEXT NOT NULL DEFAULT '🧩',
      "description" TEXT,
      "systemPrompt" TEXT,
      "provider" TEXT NOT NULL DEFAULT 'anthropic',
      "model" TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
      "insertAfter" TEXT NOT NULL DEFAULT 'auditor',
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "CustomAgentRole_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "CustomAgentRole_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES public."User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX "CustomAgentRole_userId_idx"
      ON public."CustomAgentRole" USING btree ("userId");
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid = role_table AND relkind = 'r' AND relpersistence = 'p'
    ) THEN
      RAISE EXCEPTION 'CustomAgentRole existing schema is incompatible';
    END IF;

    IF (SELECT count(*) FROM pg_attribute
        WHERE attrelid = role_table AND attnum > 0 AND NOT attisdropped) <> 13
      OR EXISTS (
        SELECT 1
        FROM (VALUES
          ('id', 'text', true, NULL::pg_catalog.text),
          ('userId', 'text', true, NULL::pg_catalog.text),
          ('name', 'text', true, NULL::pg_catalog.text),
          ('icon', 'text', true, '''🧩''::text'),
          ('description', 'text', false, NULL::pg_catalog.text),
          ('systemPrompt', 'text', false, NULL::pg_catalog.text),
          ('provider', 'text', true, '''anthropic''::text'),
          ('model', 'text', true, '''claude-haiku-4-5-20251001''::text'),
          ('insertAfter', 'text', true, '''auditor''::text'),
          ('enabled', 'boolean', true, 'true'),
          ('sortOrder', 'integer', true, '0'),
          ('createdAt', 'timestamp(3) without time zone', true, 'current_timestamp'),
          ('updatedAt', 'timestamp(3) without time zone', true, NULL::pg_catalog.text)
        ) AS expected(name, formatted_type, is_not_null, default_expression)
        LEFT JOIN pg_attribute AS column_info
          ON column_info.attrelid = role_table
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
      RAISE EXCEPTION 'CustomAgentRole existing schema is incompatible';
    END IF;

    SELECT attnum INTO id_att FROM pg_attribute
    WHERE attrelid = role_table AND attname = 'id' AND attnum > 0 AND NOT attisdropped;
    SELECT attnum INTO user_id_att FROM pg_attribute
    WHERE attrelid = role_table AND attname = 'userId' AND attnum > 0 AND NOT attisdropped;

    IF (SELECT count(*) FROM pg_constraint
        WHERE conrelid = role_table AND contype = 'p') <> 1
      OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = role_table AND contype = 'p'
          AND conname = 'CustomAgentRole_pkey'
          AND conkey = ARRAY[id_att]::pg_catalog.int2[]
          AND convalidated AND NOT condeferrable AND NOT condeferred
      ) THEN
      RAISE EXCEPTION 'CustomAgentRole existing schema is incompatible';
    END IF;

    IF (SELECT count(*) FROM pg_constraint
        WHERE conrelid = role_table AND contype = 'f') <> 1
      OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = role_table AND contype = 'f'
          AND conname = 'CustomAgentRole_userId_fkey'
          AND conkey = ARRAY[user_id_att]::pg_catalog.int2[]
          AND confrelid = user_table
          AND confkey = ARRAY[user_pk_att]::pg_catalog.int2[]
          AND confdeltype = 'c' AND confupdtype = 'c'
          AND confmatchtype = 's' AND convalidated
          AND NOT condeferrable AND NOT condeferred
      ) THEN
      RAISE EXCEPTION 'CustomAgentRole existing schema is incompatible';
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = role_table AND contype NOT IN ('p', 'f')
    ) OR EXISTS (
      SELECT 1 FROM pg_index
      WHERE indrelid = role_table AND indisunique AND NOT indisprimary
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_index AS role_index
      JOIN pg_class AS index_relation ON index_relation.oid = role_index.indexrelid
      JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
      JOIN pg_opclass AS text_btree_opclass
        ON text_btree_opclass.opcmethod = access_method.oid
      JOIN pg_attribute AS user_id_column
        ON user_id_column.attrelid = role_table AND user_id_column.attnum = user_id_att
      WHERE role_index.indrelid = role_table
        AND index_relation.relname = 'CustomAgentRole_userId_idx'
        AND index_relation.relkind = 'i'
        AND access_method.amname = 'btree'
        AND text_btree_opclass.opcname = 'text_ops'
        AND text_btree_opclass.opcdefault
        AND text_btree_opclass.opcintype = user_id_column.atttypid
        AND role_index.indclass::text = format('%s', text_btree_opclass.oid)
        AND user_id_column.attcollation = to_regcollation('pg_catalog.default')
        AND role_index.indcollation::text = format('%s', user_id_column.attcollation)
        AND role_index.indisvalid AND role_index.indisready AND role_index.indislive
        AND NOT role_index.indisunique AND NOT role_index.indisprimary
        AND NOT role_index.indisexclusion
        AND role_index.indnkeyatts = 1 AND role_index.indnatts = 1
        AND role_index.indexprs IS NULL AND role_index.indpred IS NULL
        AND role_index.indkey::text = format('%s', user_id_att)
        AND role_index.indoption::text = '0'
    ) THEN
      RAISE EXCEPTION 'CustomAgentRole existing schema is incompatible';
    END IF;
  END IF;
END
$migration$;
