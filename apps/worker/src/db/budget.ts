import { randomUUID } from "node:crypto";
import { getPool } from "./apply-results.js";

const MONTHLY_LIMIT = 30;

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export async function checkBudget(
  userId: string
): Promise<{ allowed: boolean; used: number; limit: number }> {
  const month = currentMonth();
  const pool = getPool();

  await pool.query(
    `INSERT INTO ai_budgets (id, user_id, month, used, "limit", created_at, updated_at)
     VALUES ($1, $2, $3, 0, $4, NOW(), NOW())
     ON CONFLICT (user_id, month) DO NOTHING`,
    [randomUUID(), userId, month, MONTHLY_LIMIT]
  );

  const result = await pool.query(
    `SELECT used, "limit" FROM ai_budgets WHERE user_id = $1 AND month = $2`,
    [userId, month]
  );
  const row = result.rows[0];

  return {
    allowed: row.used < row.limit,
    used: row.used,
    limit: row.limit,
  };
}

export async function incrementBudget(userId: string): Promise<void> {
  await getPool().query(
    `UPDATE ai_budgets
     SET used = used + 1,
         updated_at = NOW()
     WHERE user_id = $1 AND month = $2`,
    [userId, currentMonth()]
  );
}
