"""
Generate end-to-end request-flow diagrams (PNG) for each service of banking-app.

Every fact drawn here was read from the repo or the live cluster:
  k8s/08-ingress.yaml                -> ingress paths, rewrite-target /$2
  frontend/*/default.conf.template   -> listen port, location /api/ proxy_pass ${BACKEND_URL}
  k8s/0[3-7]-*.yaml                  -> ports, replicas, BACKEND_URL env, ClusterIP
  backend/index.js                   -> /api/* routes, single mysql2 pool
  configmap mysql-config             -> DB_HOST / DB_NAME
  kubectl get ingress / svc          -> external IP 20.252.79.97

Run:  python docs/architecture/generate_diagrams.py
Out:  docs/architecture/flow-<service>.png
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = Path(__file__).resolve().parent
SCALE = 2                      # supersample, then LANCZOS down -> crisp text
W, H = 1560, 1130

BG = "#f5f7fb"
INK = "#18212f"
MUTED = "#54637a"
EDGE = "#7c8ba0"
LANE = "#ccd6e4"

BROWSER = ("#e9f1fe", "#3568c9")
INGRESS = ("#e4f6ec", "#1d8452")
FRONTEND = ("#fff2e1", "#c07216")
BACKEND = ("#ebe8fc", "#5741c0")
DB = ("#fde7eb", "#bd3049")
NOTE = ("#fffceb", "#ab9214")

FONT_DIR = Path("C:/Windows/Fonts")

INGRESS_IP = "20.252.79.97"
BACKEND_DNS = "backend-service.banking-app.svc.cluster.local:8080"
DB_HOST = "bankingapp-mysql.mysql.database.azure.com:3306"
DB_NAME = "veera_nareshit_bank_db"


def font(size, bold=False):
    names = ("segoeuib.ttf", "arialbd.ttf") if bold else ("segoeui.ttf", "arial.ttf")
    for n in names:
        p = FONT_DIR / n
        if p.exists():
            return ImageFont.truetype(str(p), size * SCALE)
    return ImageFont.load_default()


F_TITLE = font(31, True)
F_SUB = font(15)
F_LANE = font(14, True)
F_BOX_T = font(17, True)
F_BOX = font(13)
F_EDGE = font(13, True)
F_EDGE2 = font(12)
F_STEP = font(14, True)
F_NOTE_T = font(14, True)
F_NOTE = font(13)

LINE_H = 19


def s(v):
    return int(v * SCALE)


class Canvas:
    def __init__(self, title, subtitle):
        self.img = Image.new("RGB", (s(W), s(H)), BG)
        self.d = ImageDraw.Draw(self.img)
        self.d.rectangle([0, 0, s(W), s(74)], fill="#ffffff")
        self.d.line([0, s(74), s(W), s(74)], fill="#dde4ee", width=s(1))
        self.d.text((s(40), s(16)), title, font=F_TITLE, fill=INK)
        self.d.text((s(40), s(48)), subtitle, font=F_SUB, fill=MUTED)

    # ---- text helpers -------------------------------------------------------
    def wrap(self, text, max_px, fnt):
        """wrap on spaces; keeps pre-split short lines intact"""
        if self.d.textlength(text, font=fnt) <= max_px:
            return [text]
        out, cur = [], ""
        for word in text.split(" "):
            trial = f"{cur} {word}".strip()
            if self.d.textlength(trial, font=fnt) <= max_px or not cur:
                cur = trial
            else:
                out.append(cur)
                cur = word
        if cur:
            out.append(cur)
        return out

    def _body(self, x, y, w, lines, fnt, colour):
        inner = s(w - 28)
        ty = y
        for ln in lines:
            for part in self.wrap(ln, inner, fnt):
                self.d.text((s(x + 14), s(ty)), part, font=fnt, fill=colour)
                ty += LINE_H
        return ty

    def body_height(self, w, lines, fnt=F_BOX):
        inner = s(w - 28)
        n = sum(len(self.wrap(ln, inner, fnt)) for ln in lines)
        return n * LINE_H

    # ---- shapes -------------------------------------------------------------
    def box(self, x, y, w, title, lines, colours, min_h=0):
        h = max(min_h, 40 + self.body_height(w, lines) + 12)
        fill, line = colours
        self.d.rounded_rectangle([s(x), s(y), s(x + w), s(y + h)], radius=s(11),
                                 fill=fill, outline=line, width=s(2))
        self.d.text((s(x + 14), s(y + 11)), title, font=F_BOX_T, fill=INK)
        self._body(x, y + 38, w, lines, F_BOX, MUTED)
        return h

    def note(self, x, y, w, title, lines):
        return self.box(x, y, w, title, lines, NOTE)

    def lane(self, x, y, w, h, label):
        self.d.rounded_rectangle([s(x), s(y), s(x + w), s(y + h)], radius=s(14),
                                 outline=LANE, width=s(2))
        tw = self.d.textlength(label, font=F_LANE)
        self.d.rectangle([s(x + 18) - s(6), s(y) - s(9), s(x + 18) + tw + s(6), s(y) + s(9)],
                         fill=BG)
        self.d.text((s(x + 18), s(y)), label, font=F_LANE, fill="#7a8ba3", anchor="lm")

    def _head(self, x, y, dx, dy, colour):
        n = (dx * dx + dy * dy) ** 0.5 or 1
        dx, dy = dx / n, dy / n
        px, py = -dy, dx
        L, Wd = s(12), s(5.5)
        self.d.polygon([(x, y),
                        (x - dx * L + px * Wd, y - dy * L + py * Wd),
                        (x - dx * L - px * Wd, y - dy * L - py * Wd)], fill=colour)

    def step_badge(self, x, y, n, colour=EDGE):
        r = s(13)
        self.d.ellipse([s(x) - r, s(y) - r, s(x) + r, s(y) + r],
                       fill="#ffffff", outline=colour, width=s(2))
        self.d.text((s(x), s(y)), str(n), font=F_STEP, fill=INK, anchor="mm")

    def harrow(self, x1, x2, y, label=None, sub=None, below=False, step=None,
               colour=EDGE, label_x=None, anchor_x="m"):
        self.d.line([s(x1), s(y), s(x2), s(y)], fill=colour, width=s(2))
        self._head(s(x2), s(y), s(x2 - x1), 0, colour)
        mx = (x1 + x2) / 2 if label_x is None else label_x
        if label:
            if below:
                self.d.text((s(mx), s(y + 12)), label, font=F_EDGE, fill=INK,
                            anchor=anchor_x + "t")
                if sub:
                    self.d.text((s(mx), s(y + 31)), sub, font=F_EDGE2, fill=MUTED,
                                anchor=anchor_x + "t")
            else:
                base = y - 12
                if sub:
                    self.d.text((s(mx), s(base - 18)), sub, font=F_EDGE2, fill=MUTED, anchor="mb")
                self.d.text((s(mx), s(base)), label, font=F_EDGE, fill=INK, anchor="mb")
        if step is not None:
            self.step_badge(x1, y, step, colour)

    def varrow(self, x, y1, y2, label=None, sub=None, right=True, step=None,
               colour=EDGE):
        self.d.line([s(x), s(y1), s(x), s(y2)], fill=colour, width=s(2))
        self._head(s(x), s(y2), 0, s(y2 - y1), colour)
        my = (y1 + y2) / 2
        if label:
            ax = x + 14 if right else x - 14
            anchor = "lm" if right else "rm"
            self.d.text((s(ax), s(my - 9)), label, font=F_EDGE, fill=INK, anchor=anchor)
            if sub:
                self.d.text((s(ax), s(my + 10)), sub, font=F_EDGE2, fill=MUTED, anchor=anchor)
        if step is not None:
            self.step_badge(x, y1, step, colour)

    def elbow(self, p1, p2, via, label=None, sub=None, step=None, colour=EDGE,
              label_at=None):
        """p1 -> vertical to via -> horizontal to p2.x -> vertical into p2"""
        x1, y1 = p1
        x2, y2 = p2
        pts = [(x1, y1), (x1, via), (x2, via), (x2, y2)]
        for a, b in zip(pts, pts[1:]):
            self.d.line([s(a[0]), s(a[1]), s(b[0]), s(b[1])], fill=colour, width=s(2))
        self._head(s(x2), s(y2), 0, s(y2 - via), colour)
        if label:
            lx = label_at if label_at is not None else (x1 + x2) / 2
            self.d.text((s(lx), s(via - 12)), label, font=F_EDGE, fill=INK, anchor="mb")
            if sub:
                self.d.text((s(lx), s(via + 10)), sub, font=F_EDGE2, fill=MUTED, anchor="mt")
        if step is not None:
            self.step_badge(x1, y1, step, colour)

    def save(self, name):
        out = OUT_DIR / name
        self.img.resize((W, H), Image.LANCZOS).save(out, "PNG")
        print("wrote", out)


INGRESS_RULES = [
    "annotation nginx.ingress.kubernetes.io/rewrite-target: /$2",
    "path /()(.*)                 -> banking-ui:3000",
    "path /cards(/|$)(.*)         -> cards-ui:8081",
    "path /transactions(/|$)(.*)  -> transactions-ui:8082",
    "path /loans(/|$)(.*)         -> loans-ui:8083",
]


def frontend_lines(port, extra=()):
    return [
        f"nginx:alpine, listen {port}, replicas 2",
        "image built from default.conf.template; rendered at boot by",
        "/docker-entrypoint.d/20-envsubst-on-templates.sh",
        f"env BACKEND_URL = http://{BACKEND_DNS}",
        "env NGINX_ENVSUBST_FILTER = BACKEND_URL",
        "location /       -> try_files $uri $uri/ /index.html",
        "location /api/   -> proxy_pass ${BACKEND_URL}",
        "location /health -> 200 json  (readiness + liveness)",
        *extra,
    ]


def ui_diagram(service, port, ing_path, page_desc, api_calls, routes, tables,
               api_pod, filename):
    """api_pod = ('same', ...) when the page's own nginx proxies /api,
       otherwise ('banking-ui', ...) because /api matches the ingress root rule."""
    c = Canvas(f"{service} - end-to-end request flow",
               f"AKS bankingapp-aks | namespace banking-app | ingress {INGRESS_IP} | "
               f"browser -> ingress -> nginx -> backend -> MySQL")

    # ── lane 1: page load ────────────────────────────────────────────────────
    c.lane(34, 106, 1492, 260, "  1-3   PAGE LOAD (static HTML)  ")

    c.box(60, 136, 350, "Browser", [
        f"GET http://{INGRESS_IP}{ing_path}",
        page_desc,
    ], BROWSER, min_h=120)

    c.box(520, 130, 430, "NGINX Ingress Controller", [
        "ns ingress-nginx, Service type LoadBalancer",
        f"EXTERNAL-IP {INGRESS_IP}:80",
        *INGRESS_RULES,
    ], INGRESS, min_h=210)

    c.box(1070, 130, 456, f"{service} pod", frontend_lines(port), FRONTEND, min_h=210)

    c.harrow(410, 515, 176, "GET " + ing_path, "TCP 80", step=1)
    c.harrow(950, 1065, 160, "match path", f"rewrite -> {service}:{port}", step=2)
    c.harrow(1065, 950, 310, "index.html + inline JS/CSS", None, below=True, step=3,
             label_x=1040, anchor_x="r")

    # ── lane 2: api call ─────────────────────────────────────────────────────
    c.lane(34, 420, 1492, 250, "  4-6   API CALL (fetch from the rendered page)  ")

    c.box(60, 450, 350, "Browser XHR", [
        "const API = '/api'  -> absolute path, so every call",
        "leaves the page and hits the ingress again:",
        *api_calls,
    ], BROWSER, min_h=190)

    if api_pod == "same":
        api_title = f"{service} pod  (same pods as above)"
        api_lines = [
            f"/api/... matches the ingress rule that fronts {service},",
            "so the request lands on this same nginx",
            "location /api/ -> proxy_pass ${BACKEND_URL}",
            "sets Host, X-Real-IP, X-Forwarded-For, X-Forwarded-Proto",
            "nginx does NOT rewrite the path: /api/x stays /api/x",
        ]
    else:
        api_title = "banking-ui pod  (serves /api for this page)"
        api_lines = [
            f"the page lives under {ing_path}, but fetch('/api/...') is an",
            "absolute path, so the ingress matches its ROOT rule",
            "/()(.*) -> banking-ui:3000  (not " + f"{service}:{port})",
            "location /api/ -> proxy_pass ${BACKEND_URL}",
            "sets Host, X-Real-IP, X-Forwarded-For, X-Forwarded-Proto",
        ]
    c.box(1070, 450, 456, api_title, api_lines, FRONTEND, min_h=190)

    # browser -> ingress (back up into the ingress box)
    c.elbow((410, 500), (735, 345), via=500, label=None, step=4)
    c.d.text((s(560), s(488)), "fetch /api/...", font=F_EDGE, fill=INK, anchor="lb")
    c.d.text((s(560), s(512)), f"same origin {INGRESS_IP}", font=F_EDGE2, fill=MUTED, anchor="lt")

    # ingress -> api-serving nginx
    c.elbow((860, 345), (1298, 450), via=408, label="route /api/... by path",
            sub=None, step=5, label_at=1080)

    # ── lane 3: backend + db ─────────────────────────────────────────────────
    c.lane(34, 724, 1492, 372, "  6-8   BACKEND + DATABASE (cluster-internal only)  ")

    c.box(600, 754, 456, "backend-service  (Deployment, replicas 2)", [
        "Node.js + Express, containerPort 8080",
        "Service backend-service:8080, type ClusterIP",
        "DNS backend-service.banking-app.svc.cluster.local",
        "kube-proxy load-balances across the 2 pods",
        f"routes this page uses: {routes}",
    ], BACKEND, min_h=170)

    c.box(600, 976, 456, "Azure MySQL Flexible Server", [
        DB_HOST,
        f"database {DB_NAME} (one schema, mysql2 pool)",
        f"tables touched: {tables}",
    ], DB, min_h=100)

    c.elbow((1298, 640), (828, 754), via=706, label="proxy_pass to the backend Service",
            sub="cluster DNS + kube-proxy", step=6, label_at=1060)
    c.varrow(760, 936, 972, "SQL over the mysql2 pool", "TLS, port 3306", right=False, step=7)
    c.varrow(900, 972, 942, "rows", None, right=True)

    c.note(60, 754, 470, "Response path (exact reverse)", [
        "MySQL rows -> Express res.json()",
        "-> frontend nginx proxy (body untouched)",
        "-> ingress controller -> browser, fetch() resolves",
        "",
        "The backend is ClusterIP with no ingress rule, so there is",
        "no path from the internet to :8080 - only these nginx pods",
        "can reach it, and only on /api/*.",
    ])

    c.save(filename)


ui_diagram(
    service="banking-ui", port=3000, ing_path="/",
    page_desc="single-page app: login / register / dashboard / transfer / cards / loans",
    api_calls=[
        "POST /api/auth/login | /api/auth/register",
        "GET  /api/dashboard/:accountId",
        "GET  /api/transactions/:accountId?limit=200",
        "POST /api/transfer | /api/deposit | /api/withdraw",
        "GET  /api/cards/:accountId, POST /api/cards",
        "GET  /api/loans/:accountId, POST /api/loans",
        "GET/PUT /api/profile/:userId, /api/notifications/...",
    ],
    routes="auth, dashboard, transactions, transfer, deposit, withdraw, cards, "
           "loans, beneficiaries, profile, notifications",
    tables="users, accounts, transactions, cards, loans, beneficiaries, notifications",
    api_pod="same",
    filename="flow-banking-ui.png",
)

ui_diagram(
    service="cards-ui", port=8081, ing_path="/cards",
    page_desc="cards page: list cards, issue a card, block a card",
    api_calls=[
        "GET   /api/cards/:accountId",
        "POST  /api/cards",
        "PATCH /api/cards/:id/block",
    ],
    routes="GET /api/cards/:accountId, POST /api/cards, PATCH /api/cards/:id/block",
    tables="cards, accounts, notifications",
    api_pod="banking-ui",
    filename="flow-cards-ui.png",
)

ui_diagram(
    service="transactions-ui", port=8082, ing_path="/transactions",
    page_desc="transactions page: paged history, make a transfer",
    api_calls=[
        "GET  /api/transactions/:accountId?limit=PAGE_SIZE&offset=N",
        "POST /api/transfer",
    ],
    routes="GET /api/transactions/:accountId, POST /api/transfer",
    tables="transactions, accounts, notifications",
    api_pod="banking-ui",
    filename="flow-transactions-ui.png",
)

ui_diagram(
    service="loans-ui", port=8083, ing_path="/loans",
    page_desc="loans page: list loans, apply for a loan",
    api_calls=[
        "GET  /api/loans/:accountId",
        "POST /api/loans",
    ],
    routes="GET /api/loans/:accountId, POST /api/loans",
    tables="loans, accounts, notifications",
    api_pod="banking-ui",
    filename="flow-loans-ui.png",
)


def backend_diagram():
    c = Canvas("backend-service - internal request handling",
               "Node.js + Express on ClusterIP :8080 | every caller is an in-cluster "
               "nginx pod | single mysql2 pool")

    c.lane(34, 106, 1492, 300, "  INBOUND (no internet path exists)  ")

    c.box(60, 136, 400, "Callers: the four frontend nginx pods", [
        "banking-ui       listen 3000",
        "cards-ui         listen 8081",
        "transactions-ui  listen 8082",
        "loans-ui         listen 8083",
        "",
        "each has location /api/ -> proxy_pass ${BACKEND_URL}",
        "In practice the browser's /api/* calls all land on",
        "banking-ui, because /api matches the ingress root rule.",
    ], FRONTEND, min_h=240)

    c.box(560, 136, 400, "Service backend-service", [
        "type ClusterIP (no external IP, no ingress rule)",
        "port 8080 -> targetPort 8080",
        "selector app=backend-service",
        "backend-service.banking-app.svc.cluster.local",
        "",
        "readiness /health after 10s, liveness after 20s",
    ], BACKEND, min_h=240)

    c.box(1060, 136, 466, "Express routes (backend/index.js)", [
        "POST /api/auth/register | /api/auth/login",
        "GET  /api/account/:id | /:id/balance | /lookup/:accountNumber",
        "POST /api/transfer | /api/deposit | /api/withdraw",
        "GET  /api/transactions/:accountId  (limit, offset)",
        "GET  /api/transactions/detail/:referenceId",
        "GET  /api/dashboard/:accountId",
        "GET  /api/cards/:accountId | /api/cards/:id/reveal",
        "POST /api/cards | PATCH /api/cards/:id/block|unblock",
        "GET  /api/loans/:accountId | POST /api/loans",
        "GET/POST/DELETE /api/beneficiaries...",
        "GET/PUT /api/profile/:userId",
        "GET /api/notifications/:userId | PUT .../read | .../read-all",
        "GET  /api/admin/stats | /api/admin/users | /api/admin/transactions",
        "GET  /health  (probe target)",
    ], BACKEND, min_h=240)

    c.harrow(460, 555, 210, "HTTP /api/...", "in-cluster only")
    c.harrow(960, 1055, 210, "Express router", None)

    c.lane(34, 456, 1492, 232, "  WRITE PATH  ")

    c.box(60, 486, 470, "Startup sequence (what the pod logs show)", [
        "1  connect with DB_USER / DB_PASSWORD from mysql-config",
        f"2  CREATE DATABASE IF NOT EXISTS {DB_NAME}",
        "3  CREATE TABLE IF NOT EXISTS for each table",
        "4  log 'database initialized successfully'",
        "5  listen 8080 -> log 'backend running on port 8080'",
        "6  /health returns 200 -> pod becomes Ready",
    ], NOTE, min_h=172)

    c.box(600, 486, 926, "Money-moving routes run inside one MySQL transaction", [
        "transfer / deposit / withdraw / issue card / apply loan:",
        "conn.beginTransaction()  ->  UPDATE accounts SET balance ...  ->  INSERT INTO transactions ...  "
        "->  INSERT INTO notifications ...  ->  conn.commit()",
        "any error -> conn.rollback(), so a failed transfer cannot leave a half-applied balance",
    ], NOTE, min_h=172)

    c.lane(34, 738, 1492, 358, "  DATA  ")

    c.box(560, 778, 440, "mysql2 connection pool", [
        "created once at boot, reused by every request",
        "host / user / password / db from ConfigMap mysql-config",
        "pool.query(...) and conn.execute(...) with placeholders",
    ], BACKEND, min_h=130)

    c.box(560, 976, 440, "Azure MySQL Flexible Server", [
        DB_HOST,
        f"database {DB_NAME}",
        "private VNet integration - no public endpoint;",
        "only the AKS subnet can open a connection",
    ], DB, min_h=110)

    c.varrow(700, 920, 972, "TCP 3306 / TLS", None, right=False)
    c.varrow(860, 972, 926, "result sets", None, right=True)

    c.note(60, 778, 440, "Verify any of this on the cluster", [
        "kubectl get pods -n banking-app -o wide",
        "kubectl logs -n banking-app -l app=backend-service",
        "kubectl get svc,ingress -n banking-app",
        "kubectl exec -n banking-app deploy/banking-ui --",
        "  wget -qO- http://backend-service:8080/health",
    ])

    c.note(1060, 778, 466, "Security notes worth fixing", [
        "mysql-config is a ConfigMap, so DB_USER and DB_PASSWORD",
        "are stored in plaintext and readable by anyone with get",
        "configmap in this namespace - move them to a Secret",
        "(k8s/02-secret.yaml already exists as a template).",
        "",
        "/api/admin/* has no authentication in front of it.",
    ])

    c.save("flow-backend-service.png")


backend_diagram()
