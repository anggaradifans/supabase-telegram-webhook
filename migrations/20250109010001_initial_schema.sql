-- Initial schema for personal finance tracker
-- Creates tables for accounts, categories, and transactions

-- Create accounts table
CREATE TABLE IF NOT EXISTS public.accounts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create categories table
CREATE TABLE IF NOT EXISTS public.categories (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    allowed_type TEXT DEFAULT 'both' CHECK (allowed_type IN ('income', 'outcome', 'both')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create transactions table
CREATE TABLE IF NOT EXISTS public.transactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('income', 'outcome')),
    amount DECIMAL(15,2) NOT NULL CHECK (amount >= 0),
    category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
    currency TEXT DEFAULT 'IDR' NOT NULL,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_transactions_type ON public.transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_category_id ON public.transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON public.transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_occurred_at ON public.transactions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON public.transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_categories_name ON public.categories(name);
CREATE INDEX IF NOT EXISTS idx_accounts_name ON public.accounts(name);

-- Add RLS (Row Level Security) policies if needed (optional for now)
-- Enable RLS on all tables
-- ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

-- Optional: Create a view for transaction details with category and account names
CREATE OR REPLACE VIEW public.transaction_details AS
SELECT 
    t.id,
    t.type,
    t.amount,
    t.currency,
    c.name AS category_name,
    a.name AS account_name,
    t.occurred_at,
    t.description,
    t.created_at
FROM public.transactions t
LEFT JOIN public.categories c ON t.category_id = c.id
LEFT JOIN public.accounts a ON t.account_id = a.id
ORDER BY t.occurred_at DESC;

-- Optional: Create a function to validate category type against transaction type
CREATE OR REPLACE FUNCTION public.validate_category_transaction_type()
RETURNS TRIGGER AS $$
BEGIN
    -- Check if category allows this transaction type
    IF EXISTS (
        SELECT 1 FROM public.categories 
        WHERE id = NEW.category_id 
        AND allowed_type NOT IN ('both', NEW.type)
    ) THEN
        RAISE EXCEPTION 'Category does not allow % transactions', NEW.type;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to validate category type
CREATE TRIGGER trigger_validate_category_transaction_type
    BEFORE INSERT OR UPDATE ON public.transactions
    FOR EACH ROW
    EXECUTE FUNCTION public.validate_category_transaction_type();

-- Grant permissions for the service role (adjust as needed)
-- GRANT ALL ON public.accounts TO service_role;
-- GRANT ALL ON public.categories TO service_role;
-- GRANT ALL ON public.transactions TO service_role;
-- GRANT ALL ON public.transaction_details TO service_role;
