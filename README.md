# Dissertation AWS Backend

Standalone AWS-ready backend for the dissertation app.

## Local Development

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

The server runs on `http://localhost:8080` by default.

## Endpoints

- `GET /health`
- `POST /chat`
- `GET /messages/:userId`
- `POST /messages/:userId`
- `DELETE /messages/:userId`
- `PUT /messages/:userId/:messageId/feedback`
- `POST /generate-image`

## AWS App Runner

Use this folder as the App Runner service source. Set these environment variables in App Runner:

- `PORT=8080`
- `AWS_REGION`
- `MESSAGES_TABLE`
- `AUTH_TOKEN_SECRET`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- `ANTHROPIC_API_KEY` or `CLAUDE_API_KEY`

For storage, create a DynamoDB table named by `MESSAGES_TABLE` with:

- Partition key: `pk` string
- Sort key: `sk` string

The app has an in-memory fallback when `MESSAGES_TABLE` is not set, useful for local testing only.

## Wire The Frontend To This Backend

In the frontend app (`C:\Users\user\Downloads\dissertationApp`), set:

```text
VITE_API_BASE_URL=http://localhost:8080
VITE_AUTH_API_BASE_URL=http://localhost:8080
VITE_AUTH_PROVIDER=aws
```

For AWS App Runner, replace that value with the App Runner service URL:

```text
VITE_API_BASE_URL=https://your-app-runner-service-url
VITE_AUTH_API_BASE_URL=https://your-app-runner-service-url
VITE_AUTH_PROVIDER=aws
```

The frontend still defaults to the current Supabase backend when this variable is not set.
