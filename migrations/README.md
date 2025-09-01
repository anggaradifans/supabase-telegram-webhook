# Database Migrations

This directory contains SQL migration files for the personal finance tracker database schema.

## Migration Files

### `20250109010001_initial_schema.sql`
Creates the core database schema:
- **accounts** table: Bank accounts and payment methods
- **categories** table: Transaction categories with type restrictions
- **transactions** table: Financial transactions
- Indexes for optimal performance
- Validation triggers
- Helper views

### `20250109010002_seed_data.sql`
Adds initial seed data:
- Common expense categories (Food, Transportation, etc.)
- Common income categories (Salary, Freelance, etc.)
- Indonesian bank accounts and e-wallets (BCA, Mandiri, OVO, GoPay, etc.)
- Sample transactions (commented out)

## How to Apply Migrations

### Method 1: Using Supabase CLI (Recommended)

```bash
# Make sure you're in the project root
cd /path/to/your/project

# Initialize Supabase (if not done already)
supabase init

# Link to your remote project
supabase link --project-ref YOUR_PROJECT_REF

# Apply all pending migrations
supabase db push

# Or apply migrations and start local development
supabase start
```

### Method 2: Manual Application via Dashboard

1. Go to your Supabase Dashboard
2. Navigate to **SQL Editor**
3. Copy and paste the contents of each migration file
4. Run them in order:
   1. `20250109010001_initial_schema.sql`
   2. `20250109010002_seed_data.sql`

### Method 3: Using psql (if you have direct database access)

```bash
# Connect to your database
psql "postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT-REF].supabase.co:5432/postgres"

# Apply migrations in order
\i supabase/migrations/20250109010001_initial_schema.sql
\i supabase/migrations/20250109010002_seed_data.sql
```

## Database Schema Overview

### Tables

**accounts**
- `id` (UUID, Primary Key)
- `name` (Text, Unique) - Account name (e.g., "BCA", "OVO")
- `created_at` (Timestamp)

**categories**
- `id` (UUID, Primary Key)
- `name` (Text, Unique) - Category name (e.g., "Food", "Salary")
- `allowed_type` (Text) - "income", "outcome", or "both"
- `created_at` (Timestamp)

**transactions**
- `id` (UUID, Primary Key)
- `type` (Text) - "income" or "outcome"
- `amount` (Decimal) - Always positive
- `category_id` (UUID, Foreign Key)
- `account_id` (UUID, Foreign Key)
- `currency` (Text, Default: "IDR")
- `occurred_at` (Timestamp) - When transaction happened
- `description` (Text, Optional)
- `created_at` (Timestamp) - When record was created

### Views

**transaction_details** - Joins transactions with category and account names for easier querying

### Functions & Triggers

- `validate_category_transaction_type()` - Ensures transaction type matches category's allowed_type

## Creating New Migrations

When you need to modify the schema:

1. Create a new migration file with timestamp prefix:
   ```
   supabase/migrations/YYYYMMDDHHMMSS_description.sql
   ```

2. Use this naming convention:
   - `YYYY` - Year (4 digits)
   - `MM` - Month (2 digits)
   - `DD` - Day (2 digits)
   - `HHMMSS` - Hour, minute, second (6 digits)

3. Example:
   ```
   20250109123000_add_budget_table.sql
   ```

## Best Practices

1. **Always use IF NOT EXISTS** for tables and indexes
2. **Use transactions** for complex migrations
3. **Test locally first** before applying to production
4. **Backup your database** before major schema changes
5. **Keep migrations idempotent** (safe to run multiple times)
6. **Don't modify existing migration files** - create new ones instead

## Rollback

If you need to rollback a migration, create a new migration file that undoes the changes:

```sql
-- Example rollback migration
DROP TABLE IF EXISTS new_table_that_was_added;
ALTER TABLE existing_table DROP COLUMN IF EXISTS new_column;
```

## Troubleshooting

### Permission Errors
Make sure your Supabase service role has proper permissions:
```sql
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
```

### Migration Conflicts
If you get conflicts when applying migrations:
1. Check the order of your migration files
2. Ensure timestamps are correct
3. Look for duplicate table/column names

### Local Development
To reset your local database and reapply all migrations:
```bash
supabase db reset
```
