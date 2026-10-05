-- 024_batch_capitalization_receipt_scope.sql
--
-- batch_receipt_status() must measure capitalisation created by actual
-- inventory receipts only. Opening-balance layers may later be linked to a
-- cost batch for authoritative cost-basis provenance, but that does NOT mean
-- those units were received through that batch.

BEGIN;

CREATE OR REPLACE FUNCTION batch_receipt_status()
RETURNS TABLE(
  cost_batch_id uuid,
  product_id uuid,
  product_name text,
  batch_label text,
  intended_units integer,
  received_units integer,
  remaining_units integer,
  unit_cogs_cents integer,
  intended_capitalized_cents bigint,
  received_capitalized_cents bigint,
  fully_received boolean,
  capitalization_reconciled boolean
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    b.id,
    b.product_id,
    p.name,
    b.batch_label,
    b.units_received,
    COALESCE(r.qty, 0)::int,
    COALESCE(b.units_received, 0) - COALESCE(r.qty, 0),
    b.unit_cogs_cents,

    COALESCE(
      b.capitalized_total_cents::bigint,
      COALESCE(b.unit_cogs_cents,0)::bigint * COALESCE(b.units_received,0)
    )::bigint,

    COALESCE(l.value_cents, 0)::bigint,

    b.units_received IS NOT NULL
      AND COALESCE(r.qty,0) >= b.units_received,

    b.units_received IS NOT NULL
      AND COALESCE(r.qty,0) >= b.units_received
      AND COALESCE(l.value_cents,0) = COALESCE(
        b.capitalized_total_cents::bigint,
        COALESCE(b.unit_cogs_cents,0)::bigint * COALESCE(b.units_received,0)
      )

  FROM product_cost_batches b
  JOIN products p ON p.id = b.product_id

  LEFT JOIN LATERAL (
    SELECT SUM(br.quantity) AS qty
    FROM inventory_batch_receipts br
    WHERE br.cost_batch_id = b.id
  ) r ON TRUE

  LEFT JOIN LATERAL (
    SELECT SUM(x.units_received * COALESCE(x.unit_landed_cost_cents,0)) AS value_cents
    FROM (
      SELECT DISTINCT
        icl.id,
        icl.units_received,
        icl.unit_landed_cost_cents
      FROM inventory_batch_receipts br
      JOIN inventory_cost_layers icl
        ON icl.id = br.base_layer_id
        OR icl.id = br.premium_layer_id
      WHERE br.cost_batch_id = b.id
    ) x
  ) l ON TRUE;
$$;

COMMIT;
