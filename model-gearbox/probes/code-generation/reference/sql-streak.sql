WITH days AS (
  SELECT DISTINCT user_id, login_date FROM logins
),
grouped AS (
  SELECT user_id, login_date,
         julianday(login_date) - ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY login_date) AS grp
  FROM days
),
streaks AS (
  SELECT user_id, COUNT(*) AS len, MIN(login_date) AS start
  FROM grouped
  GROUP BY user_id, grp
),
ranked AS (
  SELECT user_id, len, start,
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY len DESC, start ASC) AS rk
  FROM streaks
)
SELECT user_id, len AS longest_streak, start AS streak_start
FROM ranked
WHERE rk = 1 AND len >= 3
ORDER BY longest_streak DESC, user_id ASC
