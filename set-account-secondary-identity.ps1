param(
    [switch]$Login,
    [string]$AzureConfigDir
)

# Isolated Azure CLI profile for a secondary Dataverse identity (see SKILL.md
# -> "Two identities, two Azure profiles" for when this applies: some orgs
# have two enabled systemuser records for the same person, a tenant member
# and a guest, and a token can only ever be one of them).
#
# Everything org-specific is read from config.json (gitignored) so this
# script is not tied to any one tenant or company.

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $PSScriptRoot 'config.json'
if (-not (Test-Path $configPath)) {
    throw "config.json not found next to this script. Create it from config.example.json first."
}
$config = Get-Content $configPath -Raw | ConvertFrom-Json
if (-not $config.CRM_TENANT_ID) { throw "config.json is missing CRM_TENANT_ID." }
if (-not $config.CRM_URL) { throw "config.json is missing CRM_URL." }

if (-not $AzureConfigDir) {
    $AzureConfigDir = if ($config.CRM_AZURE_CONFIG_DIRS -and $config.CRM_AZURE_CONFIG_DIRS.Count -gt 0) {
        $config.CRM_AZURE_CONFIG_DIRS[0]
    } else {
        "$HOME\.azure-secondary-identity"
    }
}
$env:AZURE_CONFIG_DIR = $AzureConfigDir

if ($Login) {
    # --allow-no-subscriptions is required: consultants often have no Azure subscription.
    az login --tenant $config.CRM_TENANT_ID --allow-no-subscriptions
}

az account get-access-token --resource $config.CRM_URL --tenant $config.CRM_TENANT_ID --query "expiresOn" -o tsv
