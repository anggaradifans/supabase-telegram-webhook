# Telegram OCR Bot - Setup Guide

This Telegram bot now supports OCR (Optical Character Recognition) to extract text from images and process financial transactions.

## 🆕 OCR Features

1. **Image Upload**: Send a photo of a receipt or transaction document
2. **AI-Powered OCR**: Uses OpenAI Vision API to extract text
3. **Confirmation Flow**: Review and confirm extracted text before processing
4. **Manual Correction**: Edit the OCR result if needed

## Environment Variables

Add these environment variables to your Supabase project:

```bash
# Existing variables
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
TELEGRAM_SECRET_TOKEN=your_telegram_secret_token
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
ALLOWED_CHAT_IDS=comma,separated,chat,ids

# New for OCR
OPENAI_API_KEY=your_openai_api_key
```

## Setup Steps

### 1. Get OpenAI API Key
1. Go to [OpenAI API Keys](https://platform.openai.com/api-keys)
2. Create a new API key
3. Add it to your Supabase environment variables

### 2. Deploy the Function
```bash
supabase functions deploy telegram-webhook --no-verify-jwt
```

### 3. Update Environment Variables
In your Supabase dashboard:
1. Go to Edge Functions
2. Select `telegram-webhook`
3. Add the `OPENAI_API_KEY` environment variable

## 📸 How to Use OCR

### Method 1: Image Upload
1. Take a photo of your receipt/transaction document
2. Send the image to the bot
3. Wait for OCR processing (few seconds)
4. Review the extracted text
5. Reply with:
   - `yes` or `y` to confirm and save
   - `no` or `n` to cancel
   - Or send a corrected version in proper format

### Method 2: Manual Entry (existing)
Continue using text commands as before:
```
outcome 75000 Food BCA [2024-01-15 12:30] Lunch at cafe
income 500000 Salary BCA Monthly salary
```

## Example OCR Workflow

1. **Send Image**: Upload photo of receipt
2. **Bot Response**: 
   ```
   🔍 Processing your image with OCR...
   
   📋 OCR Results:
   
   outcome 25000 Food BCA Coffee and pastry
   
   🤖 Is this correct? Reply with:
   • yes or y to process the transaction
   • no or n to cancel
   • Or send a corrected version
   ```
3. **Your Response**: `yes` (or correct any errors)
4. **Confirmation**: Transaction saved with reference ID

## Supported Image Formats

- JPEG/JPG
- PNG
- WebP
- Other formats supported by Telegram

## Error Handling

- **OCR fails**: Bot will show error message, you can try again or enter manually
- **Parse error**: Bot will ask for correction or cancellation
- **Timeout**: Pending confirmations expire after 5 minutes

## Cost Considerations

- OpenAI Vision API costs approximately $0.01-0.02 per image
- Supabase Edge Functions are free up to 500k invocations/month
- Consider your usage patterns for cost planning

## Troubleshooting

1. **"OpenAI API key not configured"**: Add `OPENAI_API_KEY` to environment variables
2. **OCR returning poor results**: Ensure images are clear, well-lit, and text is readable
3. **Bot not responding to images**: Check if image format is supported by Telegram

## Tips for Better OCR Results

1. **Good lighting**: Take photos in well-lit conditions
2. **Clear focus**: Ensure text is sharp and readable
3. **Straight angle**: Keep the document straight, avoid skewed angles
4. **High contrast**: Dark text on light background works best
5. **Clean background**: Avoid cluttered backgrounds

## Security Notes

- Images are processed through OpenAI's API (review their privacy policy)
- Images are not stored permanently by the bot
- Consider privacy implications when uploading sensitive financial documents