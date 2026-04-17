# f1-fantasy-api-data

One-shot container that logs into [F1 Fantasy](https://fantasy.formula1.com/) via Playwright,
fetches league leaderboard data through the API, and uploads it to Azure Blob Storage.

## How It Works

1. **Login** — Launches a headless Chromium browser via Playwright, navigates to the F1 account login page, and authenticates (required to bypass Distil bot detection).
2. **Fetch Data** — After login, calls the F1 Fantasy API endpoints using `page.evaluate(fetch(...))` to get league standings, team data, and player info.
3. **Upload** — Saves the JSON data to Azure Blob Storage as `f1-fantasy-api-data.json`.
4. **Notify** — Sends a Telegram notification on success or failure, then exits.

## Setup

```bash
cp .env.example .env
# Fill in credentials
npm install
npx playwright install chromium
npm start
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `F1_FANTASY_EMAIL` | F1 Fantasy account email |
| `F1_FANTASY_PASSWORD` | F1 Fantasy account password |
| `F1_LEAGUE_CODE` | Target league code (default: `C7UYMMWIO07`) |
| `AZURE_STORAGE_CONNECTION_STRING` | Azure Blob Storage connection string |
| `AZURE_STORAGE_CONTAINER_NAME` | Blob container name |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for notifications |

## Deployment

### Deploy the ACI workload

Deploy the one-shot container group:

```bash
npm run deploy:aci
```

### Deploy the runner Logic App

Deploy the HTTP-triggered Logic App that starts the ACI:

```bash
npm run deploy:runner
```

After deployment, assign the runner Logic App managed identity `Contributor` on the ACI scope:

```bash
az role assignment create \
  --assignee <logicAppPrincipalId> \
  --role Contributor \
  --scope /subscriptions/<subscriptionId>/resourceGroups/<resourceGroup>/providers/Microsoft.ContainerInstance/containerGroups/<containerGroupName>
```

The `logicAppPrincipalId` value is emitted by the runner ARM deployment outputs.

### Deploy the weekly scheduler Logic App

Deploy the Monday scheduler after the runner exists:

```bash
npm run deploy:scheduler
```

Or deploy both Logic Apps in order:

```bash
npm run deploy:logicapps
```

The scheduler runs every Monday at `00:00 UTC` and invokes the runner Logic App callback URL.

### Manually trigger the runner

The runner ARM deployment outputs `runnerTriggerCallbackUrl`. You can invoke it directly:

```bash
curl -X POST "<runnerTriggerCallbackUrl>"
```

This always submits a `start` request to the configured ACI container group.

## API Documentation

See the [F1 Fantasy API Reference](../f1-fantazy-bot/docs/f1-fantasy-api.md) and
[Response Examples](../f1-fantazy-bot/docs/f1-fantasy-api-examples.md) in the bot repo.
