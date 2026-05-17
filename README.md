# Vitta — YC Hackathon Demo

SMS-powered international money transfers using **Wise API** and **AgentPhone**.

## What it does

Text a message like `Send $200 to mom` and Vitta:
1. Parses intent and amount via NLP
2. Matches the recipient from your saved contacts
3. Fetches a live Wise exchange rate and quote
4. Sends a one-click confirmation link via SMS
5. Executes the Wise transfer on approval

## Architecture

```
AgentPhone (SMS) → /api/sms/webhook → Intent Parser → Recipient Matcher
                                              ↓
                                    Wise Quote + Pending Transfer
                                              ↓
                                    Token Link → /transfer/confirm/[token]
                                              ↓
                                    /api/sms/transfer/execute → Wise Transfer
```

## Setup

```bash
npm install
cp .env.example .env.local
# Fill in .env.local with your keys
npm run dev
```

## Environment Variables

See `.env.example` for all required keys:
- **Supabase** — database for recipients, conversations, transfer log
- **Wise API** — sandbox or live credentials for quotes and transfers
- **AgentPhone** — SMS gateway API key and webhook secret

## Database

Run the migrations in order:
```bash
# Wise + Travel Pay schema
supabase/migrations/001-travel-pay-wise-api.sql

# SMS integration schema
supabase/migrations/003_sms_integration.sql
```

## Testing

```bash
npm test              # all tests
npm run test:unit     # unit tests only
npm run test:api      # API route tests
npm run test:e2e      # end-to-end flow
```
