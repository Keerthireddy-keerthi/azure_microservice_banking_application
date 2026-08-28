# Banking Microservices on AKS

## Architecture

```
                         ┌──────────────────────────────────────┐
                         │          NGINX Ingress                │
                         │   (external traffic routing)          │
                         └──────┬──────┬──────┬──────┬──────────┘
                                │      │      │      │
                    /           /cards  /txn   /loans
                    ▼           ▼      ▼      ▼
              ┌──────────┐ ┌────────┐ ┌────────┐ ┌────────┐
              │banking-ui│ │cards-ui│ │txn-ui  │ │loans-ui│
              │(nginx)   │ │(nginx) │ │(nginx) │ │(nginx) │
              │port:3000 │ │port:8081│ │port:8082│ │port:8083│
              └────┬─────┘ └────┬───┘ └────┬───┘ └────┬───┘
                   │            │           │          │
                   │   nginx proxy_pass /api/* internally
                   └────────────┴───────────┴──────────┘
                                      │
                                      ▼
                         ┌──────────────────────┐
                         │   backend-service     │
                         │   (Node.js/Express)   │
                         │   port: 8080          │
                         └──────────┬────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              ┌──────────┐  ┌──────────────┐  ┌──────────┐
              │ cards_db │  │transactions_db│  │ loans_db │
              └──────────┘  └──────────────┘  └──────────┘
                         Azure MySQL Flexible Server
```

### Key Design
- Each **frontend UI** has its own nginx that serves static HTML AND proxies `/api/*` to `backend-service` via K8s DNS
- The **Ingress** only routes to frontend services — no `/api` route exposed at ingress level
- The **backend-service** is internal-only (ClusterIP), not directly accessible from outside

## Repo Layout
```
frontend/                # All static frontend services
  banking-ui/            # Main homepage with login/register (Nginx, port 3000)
  cards-ui/              # Cards management page (Nginx, port 8081)
  transactions-ui/       # Transactions page (Nginx, port 8082)
  loans-ui/              # Loans page (Nginx, port 8083)
backend/                 # Common backend API (Node.js + MySQL, port 8080)
terraform/               # Azure infra — RG, VNet, AKS, ACR, MySQL
k8s/                     # Kubernetes manifests
  01-namespace.yaml
  02-secret.yaml         # Template (actual secret created by CI/CD)
  03-backend-service.yaml
  04-banking-ui.yaml
  05-cards-ui.yaml
  06-transactions-ui.yaml
  07-loans-ui.yaml
  08-ingress.yaml
.github/workflows/
  terraform.yml          # Provisions infrastructure
  build-deploy.yml       # Builds images → pushes to ACR → deploys to AKS
```

---

## Step-by-Step Setup Guide

### Step 1: Create Azure Service Principal

You need a Service Principal so GitHub Actions can access your Azure subscription.

```bash
# az login
az role assignment create \
  --assignee "banking-app-cicd" \
  --role "Owner" \
  --scope "/subscriptions/<YOUR_SUBSCRIPTION_ID>"
```

This outputs a JSON like:
```json
{
  "clientId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "clientSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "subscriptionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "tenantId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  ...
}
```

**Save this JSON** — you'll need the values below.

### Step 2: Add GitHub Secrets (Before Terraform)

Go to your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add these secrets:

| Secret Name | Where to Get It | Example |
|-------------|-----------------|---------|
| `AZURE_CREDENTIALS` | Full JSON output from Step 1 | `{"clientId":"...","clientSecret":"..."}` |
| `AZURE_CLIENT_ID` | `clientId` from JSON above | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `AZURE_CLIENT_SECRET` | `clientSecret` from JSON above | `xxxxxxxxxxx` |
| `AZURE_SUBSCRIPTION_ID` | `subscriptionId` from JSON above | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `AZURE_TENANT_ID` | `tenantId` from JSON above | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `MYSQL_ADMIN_USERNAME` | Choose any username | `bankadmin` |
| `MYSQL_ADMIN_PASSWORD` | Choose a strong password | `MyStr0ng!Pass#2024` |

### Step 3: Run Terraform (Provisions Infrastructure)

Push code to `main` or manually trigger the **terraform.yml** workflow.

This creates:
- Resource Group (`data`)
- VNet + subnets
- AKS cluster
- ACR (Container Registry)
- Azure MySQL Flexible Server + 3 databases

### Step 4: Get Terraform Outputs (After Terraform Completes)

Run these commands locally to get the values you need:

```bash
cd terraform
terraform output
```

This shows:
```
acr_login_server = "bankingappacr123.azurecr.io"
acr_name         = "bankingappacr123"
mysql_fqdn       = "bankingapp-mysql.mysql.database.azure.com"
```

**OR** get them from Azure Portal:
- **ACR_NAME**: Azure Portal → Container Registries → your registry → name (e.g., `bankingappacr123`)
- **ACR_LOGIN_SERVER**: Same page → Login server (e.g., `bankingappacr123.azurecr.io`)
- **MYSQL_HOST**: Azure Portal → Azure Database for MySQL → your server → Server name (e.g., `bankingapp-mysql.mysql.database.azure.com`)

### Step 5: Add Remaining GitHub Secrets (After Terraform)

| Secret Name | Where to Get It | Example |
|-------------|-----------------|---------|
| `ACR_NAME` | `terraform output acr_name` | `bankingappacr123` |
| `ACR_LOGIN_SERVER` | `terraform output acr_login_server` | `bankingappacr123.azurecr.io` |
| `MYSQL_HOST` | `terraform output mysql_fqdn` | `bankingapp-mysql.mysql.database.azure.com` |

### Step 6: Install NGINX Ingress Controller (One-time)

```bash
# Connect to your AKS cluster
az aks get-credentials --resource-group data --name bankingapp-aks

# Install ingress controller
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace
```

### Step 7: Build & Deploy (Automatic)

Push to `main` or manually trigger the **build-deploy.yml** workflow. It will:
1. Build all 5 Docker images
2. Push them to ACR with commit SHA tag
3. Replace image placeholders in k8s manifests with actual ACR images
4. Deploy everything to AKS

### Step 8: Get Your App URL

```bash
kubectl get svc -n ingress-nginx ingress-nginx-controller
```

Use the **EXTERNAL-IP** to access your app. Update `k8s/08-ingress.yaml` host if needed.

---

## All GitHub Secrets Summary

| # | Secret | Value | When to Add |
|---|--------|-------|-------------|
| 1 | `AZURE_CREDENTIALS` | Full SP JSON | Before Terraform |
| 2 | `AZURE_CLIENT_ID` | From SP JSON | Before Terraform |
| 3 | `AZURE_CLIENT_SECRET` | From SP JSON | Before Terraform |
| 4 | `AZURE_SUBSCRIPTION_ID` | From SP JSON | Before Terraform |
| 5 | `AZURE_TENANT_ID` | From SP JSON | Before Terraform |
| 6 | `MYSQL_ADMIN_USERNAME` | `bankadmin` | Before Terraform |
| 7 | `MYSQL_ADMIN_PASSWORD` | Your strong password | Before Terraform |
| 8 | `ACR_NAME` | From Terraform output | After Terraform |
| 9 | `ACR_LOGIN_SERVER` | From Terraform output | After Terraform |
| 10 | `MYSQL_HOST` | From Terraform output | After Terraform |

---

## Notes
- MySQL is deployed with **private VNet integration** — no public endpoint, reachable only from AKS
- `mysql_admin_password` is passed via `TF_VAR_mysql_admin_password` in CI/CD — never hardcode it
- Only the **backend-service** needs MySQL credentials — frontend UIs are purely static
- Backend is never exposed to internet — accessed only through frontend nginx `proxy_pass`
- Images are tagged with git commit SHA for traceability
