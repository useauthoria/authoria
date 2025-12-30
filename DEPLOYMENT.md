# Deployment Guide

## Frontend Deployment on Render

### Configuration

The frontend is configured as a **Static Site** on Render.

### Build Settings

- **Build Command**: `cd frontend && npm ci && npm run build`
- **Publish Directory**: `frontend/dist`

### Required Environment Variables

Set these in your Render dashboard (Settings → Environment):

1. **VITE_SUPABASE_URL**
   - Value: `https://mzfugvrgehzgupuowgme.supabase.co`

2. **VITE_SUPABASE_ANON_KEY**
   - Value: Your Supabase anonymous key (from your .env file)

3. **VITE_API_BASE_URL**
   - Value: `https://mzfugvrgehzgupuowgme.supabase.co/functions/v1`

4. **VITE_SHOPIFY_API_KEY** (if needed)
   - Value: Your Shopify API key

5. **VITE_ADMIN_API_KEY** (if needed)
   - Value: Your admin API key

### Deployment Steps

1. **Connect Repository** (Already done)
   - Your GitHub repo is connected to Render

2. **Configure Service**
   - Service Type: Static Site
   - Build Command: `cd frontend && npm ci && npm run build`
   - Publish Directory: `frontend/dist`

3. **Set Environment Variables**
   - Go to Settings → Environment
   - Add all required VITE_* variables listed above

4. **Deploy**
   - Render will automatically deploy on push to main branch
   - Or manually trigger a deploy from the dashboard

### Notes

- The `render.yaml` file in the root can be used for infrastructure-as-code, but static sites are typically configured through the dashboard
- Environment variables prefixed with `VITE_` are embedded into the build at build time
- After deployment, your frontend will be available at your Render URL

