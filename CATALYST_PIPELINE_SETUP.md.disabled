# Gabber three-stage Catalyst pipeline

The repository now defines this release path in `catalyst-pipelines.yaml`:

1. **development** - installs locked dependencies and checks every backend JavaScript file for syntax errors.
2. **testing** - performs a clean install and runs the complete backend test suite.
3. **deployment** - installs the pinned Catalyst CLI and deploys the backend as the `gabber-api` AppSail service.

The deployment stage runs only after both earlier stages pass. The complete pipeline is restricted to pushes or merges to `main`, so feature branches cannot deploy the server.

## One-time Catalyst console setup

1. Open the correct Gabber project in the [Catalyst console](https://console.catalyst.zoho.com/).
2. Open **Pipelines**, create a pipeline, and choose **GitHub** as the integration source.
3. Select the backend repository `NiharClover/Gabber` and the `main` branch.
4. Select the repository's `catalyst-pipelines.yaml` configuration.
5. On a trusted computer with the Catalyst CLI installed, run:

   ```powershell
   catalyst token:generate
   ```

6. In the pipeline's **Global Variables**, create a secret named `CATALYST_TOKEN` and paste the generated token. Never put this token in GitHub or in the YAML file.
7. In AppSail environment variables, configure the production values from `.env.example`. At minimum, set `NODE_ENV=production`, `JWT_SECRET`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `REDIS_HOST`, `REDIS_PORT`, `ALLOWED_ORIGINS`, and the credentials for enabled integrations. Set `DEV_MODE=false`. Do not set a fixed `PORT`; AppSail supplies `X_ZOHO_CATALYST_LISTEN_PORT` automatically.
8. Protect the GitHub `main` branch and require review plus passing checks before merging.
9. Push or merge a commit into `main`, then monitor all three stages in **Pipelines > Execution History**.

## Database release step

Database migrations are intentionally not run automatically by the deployment job. Before the first production deployment (and whenever a new migration is added), back up the production PostgreSQL database and run:

```powershell
npm ci
npm run migrate
```

Run this from a trusted machine with the production `DATABASE_URL`. This prevents an ordinary code push from unexpectedly modifying production data.

## Verification after deployment

1. Copy the AppSail URL shown by Catalyst.
2. Open `https://YOUR-APPSAIL-DOMAIN/api/health`; it should return JSON with `"status":"ok"`.
3. Set `EXPO_PUBLIC_API_URL=https://YOUR-APPSAIL-DOMAIN/api` in the mobile app's production build environment.
4. Rebuild the mobile app. A previously installed build will continue using the API URL embedded when that build was created.

## Rollback

If a release fails after deployment, use AppSail's deployment history to redeploy the last known-good version. Restore the database only from a verified backup and only when the migration itself caused a data problem.
