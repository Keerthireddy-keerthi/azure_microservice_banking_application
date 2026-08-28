# Banking Microservices on AKS (Pluralsight Demo)

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
- Each **frontend UI** has its own nginx that serves static HTML AND proxies `/api/*` requests internally to the `backend-service` via K8s DNS (`backend-service.banking-app.svc.cluster.local:8080`)
- The **Ingress** only routes to frontend services — no `/api` route exposed at ingress level
- The **backend-service** is internal-only (ClusterIP), not directly accessible from outside

## Repo layout
```
frontend/              # All static frontend services
  banking-ui/          # Main homepage (Nginx, port 3000)
  cards-ui/            # Cards page (Nginx, port 8081)
  transactions-ui/     # Transactions page (Nginx, port 8082)
  loans-ui/            # Loans page (Nginx, port 8083)
backend/               # Common backend API (Node.js + MySQL, port 8080)
terraform/             # RG "data", VNet/subnets, AKS, ACR, Azure MySQL Flexible Server
k8s/                   # namespace, secret template, 5 deployments+services, ingress
.github/workflows/
  terraform.yml        # provisions infra (plan/apply/destroy)
  build-deploy.yml     # builds images, pushes to ACR, deploys to AKS
```

## Service Design

### Frontend Services (Static + Nginx Proxy)
Each frontend is a pure static HTML/CSS/JS application served by Nginx:
- No server-side logic
- Nginx `proxy_pass` forwards `/api/*` to `backend-service` internally inside the cluster
- Lightweight container (nginx:alpine)
- No CORS issues since API calls go through the same origin

### Backend Service (Common)
A single Express.js backend that:
- Exposes all API routes: `/api/cards/:accountId`, `/api/transactions/:accountId`, `/api/loans/:accountId`
- Connects to 3 MySQL databases (cards_db, transactions_db, loans_db) on the same Azure MySQL Flexible Server
- Handles table initialization on startup
- Internal-only (ClusterIP) — not exposed to the internet

## One-time setup
1. Create an Azure Service Principal with Contributor on the subscription:
   ```
   az ad sp create-for-rbac --name "banking-app-cicd" --role Contributor \
     --scopes /subscriptions/<SUBSCRIPTION_ID> --sdk-auth
   ```
   Save the JSON output as GitHub secret `AZURE_CREDENTIALS`.

2. Add these GitHub Actions secrets (repo → Settings → Secrets → Actions):
   - `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SUBSCRIPTION_ID`, `AZURE_TENANT_ID` (from the SP above)
   - `AZURE_CREDENTIALS` (the full JSON from step 1, used by azure/login)
   - `MYSQL_ADMIN_PASSWORD` (choose a strong password)
   - `MYSQL_ADMIN_USERNAME` (defaults to `bankadmin` — must match `terraform/variables.tf` if changed)
   - `ACR_NAME`, `ACR_LOGIN_SERVER`, `MYSQL_FQDN` — fill these in **after** the first Terraform apply, using the Terraform outputs (`acr_name`, `acr_login_server`, `mysql_fqdn`)

## Deploy order
1. Push to `main` → **terraform.yml** runs, creates:
   - Resource group `data`
   - VNet + AKS subnet + delegated MySQL subnet
   - AKS cluster (system-assigned identity, ACR pull role granted)
   - ACR
   - Azure MySQL Flexible Server + 3 databases
2. Copy the Terraform outputs into the GitHub secrets listed above.
3. Install the NGINX ingress controller once on the cluster:
   ```
   az aks get-credentials -g data -n bankingapp-aks
   helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
   helm install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace
   ```
4. Push to `main` (or re-run manually) → **build-deploy.yml** builds each service image, pushes to ACR, and applies the k8s manifests.
5. Get the ingress public IP:
   ```
   kubectl get svc -n ingress-nginx ingress-nginx-controller
   ```
   Point your `host` in `k8s/20-ingress.yaml` at that IP/domain.

## Notes
- `mysql_admin_password` is marked `sensitive` in Terraform and must be supplied via `TF_VAR_mysql_admin_password` (wired from the `MYSQL_ADMIN_PASSWORD` secret) — never hardcode it.
- MySQL is deployed with **private** VNet integration (no public endpoint), reachable only from inside the VNet.
- Terraform remote state (`azurerm` backend) is commented out in `providers.tf` — enable it with a real storage account before using this beyond a demo.
- Only the **backend-service** needs MySQL credentials — the frontend UIs are purely static with nginx proxy.
- The backend is not exposed via Ingress — it's accessed internally by each frontend's nginx `proxy_pass`.
