-- Seed data for personal finance tracker
-- Adds common categories and sample accounts

-- Insert common categories
INSERT INTO public.categories (name, allowed_type) VALUES
    ('Food', 'outcome'),
    ('Transportation', 'outcome'),
    ('Shopping', 'outcome'),
    ('Entertainment', 'outcome'),
    ('Health', 'outcome'),
    ('Education', 'outcome'),
    ('Bills', 'outcome'),
    ('Rent', 'outcome'),
    ('Utilities', 'outcome'),
    ('Salary', 'income'),
    ('Freelance', 'income'),
    ('Investment', 'both'),
    ('Gift', 'both'),
    ('Transfer', 'both'),
    ('Other', 'both')
ON CONFLICT (name) DO NOTHING;

-- Insert common Indonesian bank accounts and payment methods
INSERT INTO public.accounts (name) VALUES
    ('BCA'),
    ('Mandiri'),
    ('BRI'),
    ('BNI'),
    ('CIMB'),
    ('Permata'),
    ('Cash'),
    ('OVO'),
    ('GoPay'),
    ('Dana'),
    ('ShopeePay'),
    ('LinkAja')
ON CONFLICT (name) DO NOTHING;

-- Optional: Insert some sample transactions (commented out by default)
-- Users can uncomment these if they want sample data

-- INSERT INTO public.transactions (type, amount, category_id, account_id, currency, occurred_at, description) VALUES
--     ('outcome', 50000, 
--      (SELECT id FROM public.categories WHERE name = 'Food'), 
--      (SELECT id FROM public.accounts WHERE name = 'BCA'),
--      'IDR', NOW() - INTERVAL '1 day', 'Lunch at warung'),
--     ('income', 5000000, 
--      (SELECT id FROM public.categories WHERE name = 'Salary'), 
--      (SELECT id FROM public.accounts WHERE name = 'BCA'),
--      'IDR', NOW() - INTERVAL '7 days', 'Monthly salary'),
--     ('outcome', 25000, 
--      (SELECT id FROM public.categories WHERE name = 'Transportation'), 
--      (SELECT id FROM public.accounts WHERE name = 'GoPay'),
--      'IDR', NOW() - INTERVAL '2 hours', 'Ojek ride to office');

-- Add helpful comments
COMMENT ON TABLE public.accounts IS 'Bank accounts and payment methods';
COMMENT ON TABLE public.categories IS 'Transaction categories with type restrictions';
COMMENT ON TABLE public.transactions IS 'Financial transactions with amount, category, and account';
COMMENT ON COLUMN public.transactions.amount IS 'Always positive - type field indicates income/outcome';
COMMENT ON COLUMN public.transactions.occurred_at IS 'When the transaction actually happened (can be different from created_at)';
COMMENT ON COLUMN public.categories.allowed_type IS 'Restricts what transaction types can use this category';
