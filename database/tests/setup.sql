ALTER TABLE public.telegram_users ADD COLUMN is_active boolean NOT NULL DEFAULT true;
DROP TABLE public.transaction_staging;
\ir ../../migrations/20260915010000_create_transaction_staging.sql
GRANT ALL ON public.transaction_staging TO service_role;
ALTER TABLE public.transaction_staging ENABLE ROW LEVEL SECURITY;
-- Production function body, audited September 15. Its unqualified enum must resolve.
CREATE FUNCTION public.ensure_category_type_alignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cat_type cat_allowed_type;
BEGIN
  SELECT allowed_type INTO cat_type FROM public.categories WHERE id = NEW.category_id;
  IF cat_type = 'income' AND NEW.type <> 'income' THEN
    RAISE EXCEPTION 'Category % is income-only; got type=%', NEW.category_id, NEW.type;
  ELSIF cat_type = 'outcome' AND NEW.type <> 'outcome' THEN
    RAISE EXCEPTION 'Category % is outcome-only; got type=%', NEW.category_id, NEW.type;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ensure_category_type_alignment BEFORE INSERT OR UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.ensure_category_type_alignment();
INSERT INTO public.telegram_users(telegram_user_id, supabase_user_id) VALUES
 (101, '00000000-0000-0000-0000-000000000001'), (202, '00000000-0000-0000-0000-000000000002');
