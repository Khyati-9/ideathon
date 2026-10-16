# KaamSetu WhatsApp bot

This is the no-form WhatsApp flow for farmers and workers. It is a small Node service in `whatsapp-bot.mjs` and does not change the existing frontend.

## Local test

```bash
BOT_DRY_RUN=true node whatsapp-bot.mjs
curl -s http://localhost:8787/whatsapp/health
curl -s -X POST http://localhost:8787/whatsapp/test \
  -H 'content-type: application/json' \
  -d '{"phone":"919999999999","text":"Hi"}'
```

The test endpoint runs the same state machine as a real WhatsApp message. Send the returned next option again with the same phone number. `MENU` resets the conversation.

## Campaigns, delivery receipts and replies

The same public webhook handles both chatbot messages and Meta delivery status events. Campaigns are sent through Meta's approved WhatsApp template API; the webhook is not used to send outbound messages.

Set `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN` and `BOT_DRY_RUN=false`. The template must already be approved in WhatsApp Manager and recipients must have opted in.

Create and send a campaign:

```bash
curl -X POST https://YOUR-DOMAIN/whatsapp/campaigns \
  -H 'content-type: application/json' \
  -d '{"name":"Tomato harvest update","template_name":"tomato_harvest_update","language":"en_US","recipients":["9193332780"],"launch":true}'
```

For a template with variables, pass Meta template components in `components`. To send later, omit `launch:true`, then call `POST /whatsapp/campaigns/{campaign_id}/send`.

Useful endpoints:

- `GET /whatsapp/campaigns` — list campaigns and message totals
- `GET /whatsapp/campaigns/{campaign_id}` — campaign details and tracked messages
- `GET /whatsapp/campaigns/{campaign_id}/analytics` — same data for dashboards
- `POST /whatsapp/campaigns/{campaign_id}/send` — launch a draft campaign

When Meta posts `sent`, `delivered`, `read`, or `failed` statuses to `/whatsapp/webhook`, the service updates the campaign automatically. An inbound reply is linked to the most recent campaign message for that phone and then continues through the normal KaamSetu bot flow.

Campaign state is stored in `CAMPAIGN_DATA_FILE`. On Render/AWS use a persistent disk or replace this store with the database before relying on it for high-volume campaigns; an ephemeral filesystem can lose analytics during a restart.

## Meta setup still required

The frontend URL is **not** the webhook URL. Do not enter `/app/` in Meta.

If this bot is deployed on the same server that owns `kaamsetu.phala.work`, the callback URL to share with Meta is:

```text
https://kaamsetu.phala.work/whatsapp/webhook
```

`https://kaamsetu.phala.work/app/` is only the website. A static frontend cannot receive WhatsApp POST events.

1. Create or open a Meta Developer app and add WhatsApp.
2. Add the WhatsApp Business phone number and copy its **Phone Number ID**.
3. Create a permanent/system-user access token with `whatsapp_business_messaging`.
4. Deploy this service at a public HTTPS URL.
5. In Meta, set the callback URL to `https://YOUR-DOMAIN/whatsapp/webhook` and use the same `WHATSAPP_VERIFY_TOKEN`.
6. Subscribe the WhatsApp business account to the `messages` webhook field.
7. Set `BOT_DRY_RUN=false` and add the real credentials to the hosting provider's environment variables.

`WHATSAPP_APP_SECRET` may remain blank during development. The bot will still send messages and accept webhook events, but incoming webhook signature verification is disabled until you add the Meta App Secret.

### Deploying as a separate Node service

If your current `kaamsetu.phala.work` server cannot run Node, deploy this repository as a separate web service on Render, Railway, Fly.io or your own VPS:

- Build command: leave empty
- Start command: `node whatsapp-bot.mjs`
- Port: use the platform's `PORT` value, or set `WHATSAPP_BOT_PORT` to that port
- Health check: `/whatsapp/health`

The resulting public URL will look like `https://kaamsetu-whatsapp.onrender.com`. In that case, share this URL with Meta instead:

```text
https://kaamsetu-whatsapp.onrender.com/whatsapp/webhook
```

To keep the branded URL, point a subdomain such as `bot.kaamsetu.phala.work` to that service and share:

```text
https://bot.kaamsetu.phala.work/whatsapp/webhook
```

## Deploying on Vercel

This repository now includes a Vercel adapter at `api/whatsapp/webhook.js`.

1. Push the repository to GitHub, making sure the `api/` folder and `whatsapp-bot.mjs` are included.
2. Open [Vercel](https://vercel.com), choose **Add New → Project**, import `Khyati-9/ideathon`, and keep the framework preset as **Other**.
3. Set the build command empty and the output directory empty. Vercel will serve the existing static files and detect the `api/` functions.
4. In **Project Settings → Environment Variables**, add:

```text
KAAMSETU_API_URL=https://kaamsetu.phala.work/api
WHATSAPP_GRAPH_VERSION=v23.0
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_ACCESS_TOKEN=your_meta_access_token
WHATSAPP_VERIFY_TOKEN=your_long_random_verify_token
WHATSAPP_APP_SECRET=
BOT_DRY_RUN=false
```

5. Redeploy after saving the variables.
6. Test this URL in a browser:

```text
https://YOUR-VERCEL-DOMAIN.vercel.app/api/whatsapp/health
```

It should return `{"ok":true,"service":"kaamsetu-whatsapp-bot"}`.

7. In Meta Developer → WhatsApp → Configuration, enter:

```text
Callback URL: https://YOUR-VERCEL-DOMAIN.vercel.app/api/whatsapp/webhook
Verify token: exactly the value used in WHATSAPP_VERIFY_TOKEN
```

8. Click **Verify and save**, then subscribe to the `messages` webhook field.
9. Send `Hi` to the WhatsApp test number.

If the Vercel project is connected to the custom domain `kaamsetu.phala.work`, the final Meta callback URL becomes:

```text
https://kaamsetu.phala.work/api/whatsapp/webhook
```

Do not use `/app/` in the callback URL.

## Current backend dependency

The bot already uses the live profile creation and explore endpoints:

- `POST /farmer/`
- `POST /labour/`
- `GET /workers/explore/`
- `GET /jobs/explore/`

The bid step tries `POST /offers/`. If the live backend does not expose that route yet, the bot tells the user that the offer is ready but pending backend support. A production version also needs persistent conversation sessions, an offers table, booking confirmation, payment/service-charge handling, and outbound WhatsApp templates for notifications outside the active conversation window.

