SELECT id, customer_id, amount
FROM orders
WHERE status = 'paid'
  AND amount >= 100
  AND created_at >= '2026-03-01 00:00:00'
  AND created_at <= '2026-03-31 23:59:59'
ORDER BY amount DESC, id DESC
