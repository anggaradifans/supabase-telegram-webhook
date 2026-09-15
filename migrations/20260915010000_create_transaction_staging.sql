-- Staging table for transactions that need manual confirmation before insert.
-- Used by Telegram inline confirmations and local import scripts.

CREATE TABLE IF NOT EXISTS public.transaction_staging (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'outcome' CHECK (type IN ('income', 'outcome')),
    amount DECIMAL(15,2) NOT NULL CHECK (amount >= 0),
    category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
    account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
    user_id UUID,
    currency TEXT DEFAULT 'IDR' NOT NULL,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    confirmed_at TIMESTAMP WITH TIME ZONE,
    rejected_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transaction_staging_status
    ON public.transaction_staging(status);

CREATE INDEX IF NOT EXISTS idx_transaction_staging_user_id
    ON public.transaction_staging(user_id);

CREATE INDEX IF NOT EXISTS idx_transaction_staging_occurred_at
    ON public.transaction_staging(occurred_at);

CREATE INDEX IF NOT EXISTS idx_transaction_staging_created_at
    ON public.transaction_staging(created_at);

CREATE INDEX IF NOT EXISTS idx_transaction_staging_metadata_gin
    ON public.transaction_staging USING GIN (metadata);
