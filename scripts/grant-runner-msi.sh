#!/usr/bin/env bash
# Grants the runner Logic App's system-assigned MSI Contributor on the ACI.
# Idempotent — skips if the role assignment already exists.
#
# Usage:
#   RESOURCE_GROUP=f1-fantazy-bot ACI_NAME=f1-fantasy-api-data-aci \
#     bash scripts/grant-runner-msi.sh

set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-f1-fantazy-bot}"
ACI_NAME="${ACI_NAME:-f1-fantasy-api-data-aci}"
LOGIC_APP_NAME="${LOGIC_APP_NAME:-f1-fantasy-api-data-runner}"

SUBSCRIPTION_ID="$(az account show --query id -o tsv)"

PRINCIPAL_ID="$(az resource show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$LOGIC_APP_NAME" \
  --resource-type Microsoft.Logic/workflows \
  --query identity.principalId -o tsv)"

if [ -z "$PRINCIPAL_ID" ] || [ "$PRINCIPAL_ID" = "null" ]; then
  echo "Could not resolve principalId for $LOGIC_APP_NAME — is it deployed with a system-assigned identity?" >&2
  exit 1
fi

SCOPE="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ContainerInstance/containerGroups/$ACI_NAME"

existing="$(az role assignment list \
  --assignee "$PRINCIPAL_ID" \
  --role Contributor \
  --scope "$SCOPE" \
  --query "length(@)" -o tsv)"

if [ "$existing" -gt 0 ]; then
  echo "Role assignment already exists — skipping."
else
  az role assignment create \
    --assignee-object-id "$PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal \
    --role Contributor \
    --scope "$SCOPE"
  echo "Granted Contributor on $ACI_NAME to $PRINCIPAL_ID."
fi
