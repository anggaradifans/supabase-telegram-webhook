# Supabase CLI Commands Reference

Quick reference for common Supabase CLI commands used with this project.

## Project Setup

```bash
# Initialize Supabase in existing project
supabase init

# Link to remote Supabase project
supabase link --project-ref YOUR_PROJECT_REF

# Start local development environment
supabase start

# Stop local development environment
supabase stop
```

## Database Migrations

```bash
# Apply pending migrations to remote database
supabase db push

# Pull schema changes from remote to local
supabase db pull

# Reset local database and reapply all migrations
supabase db reset

# Generate migration from schema diff
supabase db diff -f migration_name

# Create a new migration file
supabase migration new migration_name
```

## Edge Functions

```bash
# Create new function
supabase functions new function-name

# Deploy function
supabase functions deploy function-name

# Deploy function without JWT verification
supabase functions deploy function-name --no-verify-jwt

# View function logs
supabase functions logs function-name

# Delete function
supabase functions delete function-name
```

## Secrets Management

```bash
# Set multiple secrets
supabase secrets set \
  SUPABASE_URL=https://PROJECT_REF.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=your_service_role_key \
  TELEGRAM_SECRET_TOKEN=your_secret_token \
  TELEGRAM_BOT_TOKEN=your_bot_token \
  ALLOWED_CHAT_IDS=123456789

# List all secrets
supabase secrets list

# Unset a secret
supabase secrets unset SECRET_NAME
```

## Database Direct Access

```bash
# Connect to local database
supabase db connect

# Connect to remote database
supabase db connect --url postgresql://...

# Execute SQL file
supabase db execute --file path/to/file.sql

# Dump database schema
supabase db dump --schema-only

# Dump database data
supabase db dump --data-only
```

## Project Status & Info

```bash
# Check project status
supabase status

# Get project info
supabase projects list

# View project URL and keys
supabase projects api-keys
```

## Type Generation (for TypeScript)

```bash
# Generate TypeScript types from database schema
supabase gen types typescript --project-id YOUR_PROJECT_REF > types/supabase.ts

# Generate types for local database
supabase gen types typescript --local > types/supabase.ts
```

## Useful Workflows

### Initial Project Setup
```bash
# 1. Initialize and link project
supabase init
supabase link --project-ref YOUR_PROJECT_REF

# 2. Apply database migrations
supabase db push

# 3. Deploy edge functions
supabase functions deploy telegram-webhook --no-verify-jwt

# 4. Set secrets
supabase secrets set TELEGRAM_BOT_TOKEN=your_token
```

### Development Workflow
```bash
# 1. Start local environment
supabase start

# 2. Make changes to functions/migrations
# ... edit files ...

# 3. Test locally, then deploy
supabase functions deploy function-name
supabase db push
```

### Backup & Restore
```bash
# Backup database
supabase db dump > backup.sql

# Restore from backup (to local)
supabase db reset
psql -h localhost -p 54322 -U postgres -d postgres < backup.sql
```

## Environment Variables

Create a `.env.local` file for local development:
```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=your_local_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_local_service_role_key
```

## Common Issues & Solutions

### Authentication Issues
```bash
# Re-login if tokens expired
supabase login

# Check current user
supabase projects list
```

### Migration Issues
```bash
# Force reset if migrations are out of sync
supabase db reset --force

# Manual schema sync
supabase db pull
```

### Function Deployment Issues
```bash
# Check function logs for errors
supabase functions logs telegram-webhook

# Deploy with verbose output
supabase functions deploy telegram-webhook --debug
```

For more commands, run:
```bash
supabase help
supabase [command] --help
```
