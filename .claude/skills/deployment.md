# Deployment Skill

Use this skill when deploying code to production, configuring server infrastructure, troubleshooting production issues, or managing the deployment pipeline.

## When to Use
- Deploying new code to the production server
- Configuring or modifying Nginx, PM2, or SSL settings
- Troubleshooting production errors (server logs, process status)
- Setting up new environments or servers
- Rolling back a failed deployment
- Checking production health

## Server Information

| Item | Value |
|------|-------|
| Server IP | `163.7.1.94` |
| OS | Rocky Linux |
| Domain | `www.baseimage.cn` |
| SSL | Let's Encrypt (auto-renew via certbot-renew.timer) |
| SSH Key | `~/Desktop/baseimage.pem` |
| App Directory | `/root/ai-filter-lark` |
| Node Process | Managed by PM2, process name: `ai-filter` |
| App Port | 3001 (Express serves both API and static frontend) |

## Standard Deployment Flow

### One-Command Deploy (Most Common)
```bash
# From local machine — build, commit, push, deploy in sequence
npm run build
git add <files> && git commit -m "message"
git push origin main
ssh -i ~/Desktop/baseimage.pem root@163.7.1.94 \
  "cd /root/ai-filter-lark && git pull origin main && npm run build && pm2 restart ai-filter"
```

### Step-by-Step Deploy (When Debugging)
```bash
# 1. Build locally first to catch errors
npm run build

# 2. Commit and push
git add <files> && git commit -m "message"
git push origin main

# 3. SSH and pull
ssh -i ~/Desktop/baseimage.pem root@163.7.1.94

# On server:
cd /root/ai-filter-lark
git pull origin main

# 4. Install deps (only if package.json changed)
npm run install:all

# 5. Build frontend on server
npm run build

# 6. Restart backend
pm2 restart ai-filter

# 7. Verify
pm2 status
pm2 logs ai-filter --lines 10 --nostream
curl -s http://localhost:3001/api/tables | head -c 200
```

### When to `install:all`
Only run `npm run install:all` on the server when:
- `package.json` or `package-lock.json` changed in either frontend/ or backend/
- A new dependency was added
- Deployment fails with "Cannot find module" errors

Regular code-only changes do NOT need `install:all`.

## PM2 Commands

```bash
# Process management
pm2 status                          # Check process status
pm2 restart ai-filter               # Restart (zero-downtime)
pm2 stop ai-filter                  # Stop process
pm2 start ai-filter                 # Start process

# Logs
pm2 logs ai-filter --lines 20 --nostream   # Last 20 lines (one-shot)
pm2 logs ai-filter                          # Stream logs (live tail)

# Monitoring
pm2 monit                           # CPU/memory dashboard
```

## Nginx Configuration

Config file: `/etc/nginx/conf.d/ai-filter.conf`

### Key Settings for SSE
```nginx
# SSE long connections require these settings:
proxy_buffering off;           # Don't buffer SSE events
proxy_cache off;               # Don't cache SSE streams
proxy_read_timeout 86400s;     # Keep SSE connections alive (24h)
proxy_send_timeout 86400s;

# Also set in app code:
# res.setHeader("X-Accel-Buffering", "no");  — per-request override
```

### View/Edit Nginx Config
```bash
ssh -i ~/Desktop/baseimage.pem root@163.7.1.94 \
  "cat /etc/nginx/conf.d/ai-filter.conf"

# After editing:
ssh -i ~/Desktop/baseimage.pem root@163.7.1.94 \
  "nginx -t && systemctl reload nginx"
```

## SSL Certificate

- Provider: Let's Encrypt via Certbot
- Auto-renewal: `certbot-renew.timer` (systemd timer)
- Manual renewal: `certbot renew --nginx`
- Check expiry: `certbot certificates`

## Rollback Strategy

### Quick Rollback (Revert to Previous Commit)
```bash
ssh -i ~/Desktop/baseimage.pem root@163.7.1.94 \
  "cd /root/ai-filter-lark && git log --oneline -5"
# Note the commit hash to revert to

ssh -i ~/Desktop/baseimage.pem root@163.7.1.94 \
  "cd /root/ai-filter-lark && git checkout <commit-hash> && npm run build && pm2 restart ai-filter"
```

### Safe Rollback (Keep History)
```bash
# Locally: revert the commit
git revert HEAD
git push origin main

# Then deploy normally
ssh -i ~/Desktop/baseimage.pem root@163.7.1.94 \
  "cd /root/ai-filter-lark && git pull origin main && npm run build && pm2 restart ai-filter"
```

### Emergency: Process Won't Start
```bash
ssh -i ~/Desktop/baseimage.pem root@163.7.1.94

# Check what's wrong
pm2 logs ai-filter --lines 30 --nostream

# Common fixes:
# 1. Missing env vars
cat /root/ai-filter-lark/backend/.env

# 2. Port already in use
lsof -i :3001
kill -9 <pid>
pm2 restart ai-filter

# 3. Module not found
cd /root/ai-filter-lark && npm run install:all
pm2 restart ai-filter
```

## Health Checks

### Quick Smoke Test (After Deploy)
```bash
# API responds
curl -s http://localhost:3001/api/tables | head -c 100

# Frontend serves
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/

# External access works
curl -s -o /dev/null -w "%{http_code}" https://www.baseimage.cn/
```

### SSE Connection Test
```bash
# Test SSE endpoint (should receive connected event within 1s)
curl -s -N "http://localhost:3001/api/sync/documents/doc_default/events?clientId=test" --max-time 3
```

### AI Service Test
```bash
# Check if ARK API key is configured
grep ARK_API_KEY /root/ai-filter-lark/backend/.env

# Check recent AI logs
tail -50 /root/ai-filter-lark/backend/logs/AI\ 日志.log
```

## Production Architecture

```
Internet → Nginx (:80/:443) → Express (:3001)
                                  ├── API routes (/api/*)
                                  ├── SSE routes (/api/sync/*)
                                  └── Static files (frontend/dist/*)
```

Express in production mode (`npm run start`):
1. Serves the built frontend from `frontend/dist/` as static files
2. Handles all `/api/*` routes
3. Manages SSE connections with 30s heartbeat
4. Logs to `backend/logs/`

## Environment Variables

Backend `.env` file (`/root/ai-filter-lark/backend/.env`):
```
ARK_API_KEY=<volcano-ark-api-key>    # Required for all AI features
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3  # Optional, has default
ARK_MODEL=ep-20260412192731-vwdh7    # Optional, has default
PORT=3001                             # Optional, has default
```

**Never commit `.env` to git.** Use `.env.example` as template.

## Deployment Checklist

Before deploying, verify:
- [ ] `npm run build` succeeds locally (catches TypeScript errors)
- [ ] No `.env` or credentials in staged files
- [ ] If new deps added: will need `npm run install:all` on server
- [ ] If Nginx config changed: will need `nginx -t && systemctl reload nginx`
- [ ] After deploy: smoke test API + frontend + SSE
- [ ] Check `pm2 logs` for startup errors

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `git push` rejected | Remote has newer commits | `git pull --rebase origin main` then push again |
| `EADDRINUSE :3001` | Old process still running | `lsof -i :3001` then `kill -9 <pid>` |
| SSE not working on production | Nginx buffering | Check `proxy_buffering off` in nginx config |
| AI features return 500 | Missing ARK_API_KEY | Check `backend/.env` on server |
| Frontend shows old version | Browser cache | Hard refresh; or check `npm run build` ran on server |
| `Cannot find module` | Missing npm install | `npm run install:all` on server |
