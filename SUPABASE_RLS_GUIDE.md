# Supabase RLS Guide

This project now includes [migrations/20260712_add_rls_policies.sql](migrations/20260712_add_rls_policies.sql). It enables Row Level Security and adds baseline policies for the app tables.

## Apply the policies

1. Open the Supabase dashboard for your project.
2. Go to **SQL Editor**.
3. Paste the contents of `migrations/20260712_add_rls_policies.sql`.
4. Run the migration.
5. Confirm the tables now show **RLS enabled** in the Table Editor.

If you also use the `faces` table, run [migrations/20260525_create_faces_table.sql](migrations/20260525_create_faces_table.sql) first, then apply the RLS migration.

## Test the policies

Use the **SQL Editor** or the **Table Editor** with different auth contexts.

1. Sign in as a normal employee and confirm:
   - `select` only returns that employee's rows for `profiles`, `attendance`, `leave_requests`, `contributions`, `performance_evaluations`, and `notifications`.
   - `insert` and `update` fail for records owned by another user.
2. Sign in as a supervisor and confirm:
   - You can read all rows in the protected tables.
   - You can create and update tasks and performance reviews.
3. Try a direct query against a row owned by another user.
   - It should return no rows or a permission error.
4. Try a direct insert with a fake `employee_id`, `user_id`, or `profile_id`.
   - It should be rejected by the `with check` clause.

## Quick checks

- The app should still work for the signed-in user without relying on browser storage as the source of truth.
- File uploads should be tested separately with bucket policies if you add them later.
- If a query starts failing after RLS is enabled, inspect the policy and the column used for ownership first.

## Recommended verification queries

```sql
-- Check whether RLS is enabled
select relname, relrowsecurity
from pg_class
join pg_namespace on pg_namespace.oid = pg_class.relnamespace
where nspname = 'public'
  and relname in ('profiles', 'tasks', 'attendance', 'leave_requests', 'contributions', 'performance_evaluations', 'notifications', 'faces');

-- Check existing policies
select schemaname, tablename, policyname, permissive, roles, cmd
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
```

## Notes

- Keep the client-side filters in React as UX only.
- Treat the database policies as the real security boundary.